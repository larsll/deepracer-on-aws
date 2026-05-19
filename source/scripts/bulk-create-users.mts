#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bulk user creation script for DeepRacer on AWS.
 *
 * Creates Cognito users without email addresses from a CSV file. Each user is
 * assigned a permanent password and added to the dr-racers group. The preSignUp
 * Lambda trigger fires automatically to create the matching DynamoDB profile.
 *
 * Usage:
 *   pnpm tsx scripts/bulk-create-users.mts --user-pool-id <id> --csv <file> [options]
 *   pnpm tsx scripts/bulk-create-users.mts --namespace <ns> --csv <file> [options]
 *
 * Options:
 *   --user-pool-id <id>   Cognito User Pool ID (e.g. eu-west-1_XXXXXXXXX)
 *   --namespace <ns>      Stack namespace; used to auto-discover the User Pool by name
 *   --csv <file>          Path to CSV file (required columns: username, password)
 *   --group <name>        Cognito group to add users to (default: dr-racers)
 *   --region <region>     AWS region (default: AWS_DEFAULT_REGION or AWS_REGION env var)
 *   --dry-run             Validate input and print plan without creating anything
 *   --pdf <file>          Write a PDF of credential cards to this path after processing
 *   --console-url <url>   Console URL printed on each credential card (required with --pdf)
 *   --event-url <url>     Event URL printed on each credential card (required with --pdf)
 *   --pdf-title <text>    Title shown in the card header (default: "DeepRacer Grand Prix")
 *   --paper <size>        Paper size: a4 (default) or letter
 *   --font-body <font>    Body font name or font file path (default: Helvetica)
 *   --font-body-bold <f>  Bold body font name or font file path (default: Helvetica-Bold)
 *   --font-mono <font>    Mono font name or font file path (default: Courier)
 *   --font-mono-bold <f>  Bold mono font name or font file path (default: Courier-Bold)
 *
 * CSV format (first row must be the header):
 *   username,password
 *   aB3dEfGhIjKlMnO,MyP@ssw0rd1!
 *   pQrStUvWxYz1234,S3cur3P@ss2!
 *
 * The username column is used as the Cognito Username, preferred_username,
 * and custom:racerName simultaneously. It must be exactly 15 characters:
 * letters (A-Z, a-z), digits (0-9), or hyphens. This matches the internal
 * RESOURCE_ID_REGEX enforced by the preSignUp Lambda trigger.
 *
 * Password requirements (enforced by Cognito):
 *   - At least 8 characters
 *   - Uppercase letter, lowercase letter, digit, and symbol
 */

import { createWriteStream, existsSync, readFileSync } from 'fs';

import PDFDocument from 'pdfkit';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUserPoolsCommand,
  MessageActionType,
} from '@aws-sdk/client-cognito-identity-provider';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GROUP = 'dr-racers';
const USER_POOL_NAME_SUFFIX = 'DeepRacerIndyUserPool';
const RESOURCE_ID_REGEX = /^[A-Za-z0-9-]{15}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserRow {
  /**
   * The resource ID: used as Cognito Username, preferred_username, and custom:racerName.
   * Must match RESOURCE_ID_REGEX: exactly 15 chars, [A-Za-z0-9-].
   */
  username: string;
  /** Plaintext password (from CSV) */
  password: string;
}

interface UserResult {
  username: string;
  status: 'created' | 'failed' | 'dry-run';
  error?: string;
}

interface PdfFontConfig {
  body: string;
  bodyBold: string;
  mono: string;
  monoBold: string;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function parseCsv(content: string): UserRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new Error('CSV must have a header row and at least one data row.');
  }

  const header = lines[0]
    .toLowerCase()
    .split(',')
    .map((h) => h.trim());
  const usernameIdx = header.indexOf('username');
  const passwordIdx = header.indexOf('password');

  if (usernameIdx === -1) throw new Error('CSV is missing required column: username');
  if (passwordIdx === -1) throw new Error('CSV is missing required column: password');

  const rows: UserRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    const username = cols[usernameIdx] ?? '';
    const password = cols[passwordIdx] ?? '';

    if (!username || !password) {
      throw new Error(`Row ${i + 1}: username and password are required.`);
    }

    rows.push({ username, password });
  }

  return rows;
}

function validateRow(row: UserRow, lineNum: number): string | null {
  if (!RESOURCE_ID_REGEX.test(row.username)) {
    return `Row ${lineNum}: username "${row.username}" is invalid. Must be exactly 15 characters (letters, digits, hyphens).`;
  }
  if (row.password.length < 8) {
    return `Row ${lineNum}: password must be at least 8 characters.`;
  }
  return null;
}

async function discoverUserPoolId(client: CognitoIdentityProviderClient, namespace: string): Promise<string> {
  const poolName = `${namespace}-${USER_POOL_NAME_SUFFIX}`;
  let nextToken: string | undefined;

  do {
    const response = await client.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: nextToken }));
    const match = (response.UserPools ?? []).find((p) => p.Name === poolName);
    if (match?.Id) return match.Id;
    nextToken = response.NextToken;
  } while (nextToken);

  throw new Error(`Could not find a user pool named "${poolName}" in the configured region.`);
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

function resolvePdfFont(doc: PDFKit.PDFDocument, alias: string, fontSpec: string): string {
  // If it looks like a file path, register it. Otherwise use it as a built-in PDF font name.
  if (/[\\/]/.test(fontSpec) || /\.(ttf|otf|ttc)$/i.test(fontSpec)) {
    if (!existsSync(fontSpec)) {
      throw new Error(`Font file not found: ${fontSpec}`);
    }
    doc.registerFont(alias, fontSpec);
    return alias;
  }

  return fontSpec;
}

function generateCredentialsPdf(
  rows: UserRow[],
  outputPath: string,
  consoleUrl: string,
  eventUrl: string,
  title: string,
  paper: 'a4' | 'letter',
  fonts: PdfFontConfig,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // A4: 595.28 × 841.89 pt   Letter: 612 × 792 pt
    const pageW = paper === 'letter' ? 612   : 595.28;
    const pageH = paper === 'letter' ? 792   : 841.89;
    const pdfSize = paper === 'letter' ? 'LETTER' : 'A4';

    const doc = new PDFDocument({ size: pdfSize, margin: 36, autoFirstPage: false });
    const bodyFont = resolvePdfFont(doc, 'Body', fonts.body);
    const bodyBoldFont = resolvePdfFont(doc, 'BodyBold', fonts.bodyBold);
    const monoFont = resolvePdfFont(doc, 'Mono', fonts.mono);
    const monoBoldFont = resolvePdfFont(doc, 'MonoBold', fonts.monoBold);

    const stream = createWriteStream(outputPath);
    doc.pipe(stream);
    stream.on('error', reject);
    stream.on('finish', resolve);

    // Layout: 1 column × 2 rows = 2 cards per page (large, easy-to-read).
    const margin = 36;
    const gapY   = 18;
    const cardW  = pageW - margin * 2;
    const cardH  = (pageH - margin * 2 - gapY) / 2;
    const hdrH   = 40;
    const pad    = 16;
    // DeepRacer-aligned palette from existing website assets/constants.
    const accent = '#16191F';
    const mid    = '#935DD1';
    const muted  = '#779EFF';
    const bg     = '#F5F7FF';
    const border = '#C9D6FF';
    const ink    = '#0d1f30';

    // Typography: keep a small, consistent scale for better readability.
    const titleSize = 16;
    const labelSize = 10;
    const valueSize = 18;
    const urlSize = 12;

    // Vertical rhythm.
    const gapLabelToValue = 15;
    const gapSection = 28;
    const gapAfterDivider = 12;
    const lineH = 0.6;

    rows.forEach((row, idx) => {
      const posOnPage = idx % 2;
      if (posOnPage === 0) doc.addPage();

      const x = margin;
      const y = margin + posOnPage * (cardH + gapY);

      // Card background
      doc.roundedRect(x, y, cardW, cardH, 6).fillAndStroke(bg, border);

      // Header bar
      doc.roundedRect(x, y, cardW, hdrH, 6).fill(accent);
      doc.rect(x, y + hdrH - 6, cardW, 6).fill(accent);
      doc.rect(x, y + hdrH - 4, cardW, 4).fill(mid);

      doc.fillColor('#ffffff').font(bodyBoldFont).fontSize(titleSize)
        .text(title, x + pad, y + 10, { width: cardW - pad * 2 });

      // Body
      let cy = y + hdrH + pad;

      // USERNAME
      doc.fillColor(muted).font(bodyBoldFont).fontSize(labelSize).text('USERNAME', x + pad, cy);
      cy += gapLabelToValue;
      doc.fillColor(ink).font(monoBoldFont).fontSize(valueSize).text(row.username, x + pad, cy);
      cy += gapSection;

      // PASSWORD
      doc.fillColor(muted).font(bodyBoldFont).fontSize(labelSize).text('PASSWORD', x + pad, cy);
      cy += gapLabelToValue;
      doc.fillColor(ink).font(monoBoldFont).fontSize(valueSize).text(row.password, x + pad, cy);
      cy += gapSection;

      // Divider
      cy += 2;
      doc.moveTo(x + pad, cy).lineTo(x + cardW - pad, cy)
        .strokeColor(border).lineWidth(lineH).stroke();
      cy += gapAfterDivider;

      // CONSOLE URL
      doc.fillColor(muted).font(bodyBoldFont).fontSize(labelSize).text('CONSOLE', x + pad, cy);
      cy += gapLabelToValue;
      doc.fillColor(mid).font(bodyFont).fontSize(urlSize).text(consoleUrl, x + pad, cy, { link: consoleUrl });
      cy += gapSection;

      // EVENT URL
      doc.fillColor(muted).font(bodyBoldFont).fontSize(labelSize).text('EVENT', x + pad, cy);
      cy += gapLabelToValue;
      doc.fillColor(mid).font(bodyFont).fontSize(urlSize).text(eventUrl, x + pad, cy, { link: eventUrl });
    });

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Core user creation
// ---------------------------------------------------------------------------

async function createUser(
  client: CognitoIdentityProviderClient,
  userPoolId: string,
  group: string,
  row: UserRow,
): Promise<void> {
  // 1. Create the Cognito user with a suppressed invitation (no email sent).
  //    Username = preferred_username = custom:racerName = the value from the CSV.
  //    The preSignUp Lambda trigger fires here and creates the DynamoDB profile.
  await client.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: row.username,
      MessageAction: MessageActionType.SUPPRESS,
      UserAttributes: [
        { Name: 'preferred_username', Value: row.username },
        { Name: 'custom:racerName', Value: row.username },
      ],
    }),
  );

  // 2. Set a permanent password so the user is not forced to change it on first sign-in.
  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: row.username,
      Password: row.password,
      Permanent: true,
    }),
  );

  // 3. Add the user to the target group.
  await client.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: row.username,
      GroupName: group,
    }),
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const csvPath = args.csv as string | undefined;
  const userPoolIdArg = args['user-pool-id'] as string | undefined;
  const namespace = args.namespace as string | undefined;
  const group = (args.group as string | undefined) ?? DEFAULT_GROUP;
  const region = (args.region as string | undefined) ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION;
  const isDryRun = args['dry-run'] === true;
  const pdfPath    = args.pdf as string | undefined;
  const consoleUrl = args['console-url'] as string | undefined;
  const eventUrl   = args['event-url'] as string | undefined;
  const pdfTitle   = (args['pdf-title'] as string | undefined) ?? 'DeepRacer Grand Prix';
  const paperRaw   = ((args.paper as string | undefined) ?? 'a4').toLowerCase();
  const paper      = (paperRaw === 'letter' ? 'letter' : 'a4') as 'a4' | 'letter';
  const fonts: PdfFontConfig = {
    body: (args['font-body'] as string | undefined) ?? process.env.PDF_FONT_BODY ?? 'Helvetica',
    bodyBold: (args['font-body-bold'] as string | undefined) ?? process.env.PDF_FONT_BODY_BOLD ?? 'Helvetica-Bold',
    mono: (args['font-mono'] as string | undefined) ?? process.env.PDF_FONT_MONO ?? 'Courier',
    monoBold: (args['font-mono-bold'] as string | undefined) ?? process.env.PDF_FONT_MONO_BOLD ?? 'Courier-Bold',
  };

  // ── Validate required args ────────────────────────────────────────────────

  if (!csvPath) {
    console.error('Error: --csv <file> is required.');
    process.exit(1);
  }

  if (!userPoolIdArg && !namespace) {
    console.error('Error: provide either --user-pool-id <id> or --namespace <ns>.');
    process.exit(1);
  }

  if (pdfPath && !consoleUrl) {
    console.error('Error: --console-url <url> is required when --pdf is used.');
    process.exit(1);
  }

  if (pdfPath && !eventUrl) {
    console.error('Error: --event-url <url> is required when --pdf is used.');
    process.exit(1);
  }

  // ── Read and validate CSV ────────────────────────────────────────────────

  let csvContent: string;
  try {
    csvContent = readFileSync(csvPath, 'utf-8');
  } catch {
    console.error(`Error: cannot read file "${csvPath}".`);
    process.exit(1);
  }

  let rows: UserRow[];
  try {
    rows = parseCsv(csvContent);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }

  // Validate all rows up-front and check for duplicate usernames
  const seen = new Set<string>();
  const validationErrors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const err = validateRow(rows[i], i + 2); // +2: 1-based + header row
    if (err) validationErrors.push(err);

    const key = rows[i].username.toLowerCase();
    if (seen.has(key)) {
      validationErrors.push(`Row ${i + 2}: duplicate username "${rows[i].username}".`);
    }
    seen.add(key);
  }

  if (validationErrors.length > 0) {
    console.error('Validation errors found:');
    for (const e of validationErrors) console.error(`  ${e}`);
    process.exit(1);
  }

  // ── Resolve user pool ID ─────────────────────────────────────────────────

  const client = new CognitoIdentityProviderClient({ region });

  let userPoolId: string;
  if (userPoolIdArg) {
    userPoolId = userPoolIdArg;
  } else {
    console.log(`Discovering user pool for namespace "${namespace}"…`);
    try {
      userPoolId = await discoverUserPoolId(client, namespace as string);
      console.log(`Found user pool: ${userPoolId}`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // ── Print plan ───────────────────────────────────────────────────────────

  console.log('');
  console.log(`User pool : ${userPoolId}`);
  console.log(`Group     : ${group}`);
  console.log(`Users     : ${rows.length}`);
  if (isDryRun) console.log('Mode      : DRY RUN (no users will be created)');
  console.log('');

  // ── Create users ─────────────────────────────────────────────────────────

  const results: UserResult[] = [];

  for (const row of rows) {
    if (isDryRun) {
      console.log(`  [dry-run] ${row.username}`);
      results.push({ username: row.username, status: 'dry-run' });
      continue;
    }

    process.stdout.write(`  Creating ${row.username}… `);
    try {
      await createUser(client, userPoolId, group, row);
      process.stdout.write('OK\n');
      results.push({ username: row.username, status: 'created' });
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      process.stdout.write('FAILED\n');
      results.push({ username: row.username, status: 'failed', error: message });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  const created = results.filter((r) => r.status === 'created').length;
  const failed = results.filter((r) => r.status === 'failed');

  console.log('');
  if (!isDryRun) {
    console.log(`Done. ${created}/${rows.length} users created.`);
    if (failed.length > 0) {
      console.log('');
      console.log('Failures:');
      for (const r of failed) {
        console.log(`  ${r.username}: ${r.error}`);
      }
      process.exit(1);
    }
  }

  // ── Generate PDF ─────────────────────────────────────────────────────────

  if (pdfPath) {
    process.stdout.write(`\nGenerating credentials PDF → ${pdfPath}… `);
    try {
      await generateCredentialsPdf(rows, pdfPath, consoleUrl!, eventUrl!, pdfTitle, paper, fonts);
      process.stdout.write('OK\n');
    } catch (e) {
      process.stdout.write('FAILED\n');
      console.error(`PDF error: ${(e as Error).message}`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
