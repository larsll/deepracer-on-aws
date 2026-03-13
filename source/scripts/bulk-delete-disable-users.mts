#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bulk user deletion/disabling script for DeepRacer on AWS.
 *
 * Reads usernames from a CSV file and, for each user:
 *   - If the user has NO models in DynamoDB → the Cognito account is deleted.
 *   - If the user HAS models in DynamoDB   → the Cognito account is disabled.
 *
 * Usage:
 *   pnpm tsx scripts/bulk-delete-disable-users.mts --user-pool-id <id> --csv <file> [options]
 *   pnpm tsx scripts/bulk-delete-disable-users.mts --namespace <ns> --csv <file> [options]
 *
 * Options:
 *   --user-pool-id <id>   Cognito User Pool ID (e.g. eu-west-1_XXXXXXXXX)
 *   --namespace <ns>      Stack namespace; used to auto-discover the User Pool and DynamoDB table
 *   --csv <file>          Path to CSV file (required column: username)
 *   --table-name <name>   DynamoDB table name (default: <namespace>-DeepRacerIndy.Main)
 *   --region <region>     AWS region (default: AWS_DEFAULT_REGION or AWS_REGION env var)
 *   --dry-run             Print the planned action for each user without making changes
 *
 * File format — either a CSV with a header row (additional columns are ignored):
 *   username
 *   aB3dEfGhIjKlMnO
 *   pQrStUvWxYz1234
 *
 * …or a plain text file with one username per line (no header):
 *   aB3dEfGhIjKlMnO
 *   pQrStUvWxYz1234
 */

import { readFileSync } from 'fs';

import {
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  CognitoIdentityProviderClient,
  ListUserPoolsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DeleteItemCommand, DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_POOL_NAME_SUFFIX = 'DeepRacerIndyUserPool';
const DYNAMO_TABLE_SUFFIX = 'DeepRacerIndy.Main';
const RESOURCE_ID_REGEX = /^[A-Za-z0-9-]{15}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserRow {
  username: string;
}

type UserAction = 'delete' | 'disable' | 'dry-run-delete' | 'dry-run-disable';

interface UserResult {
  username: string;
  action: UserAction;
  status: 'ok' | 'failed';
  error?: string;
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

  if (lines.length === 0) {
    throw new Error('File is empty.');
  }

  // If the first line contains a "username" column, parse as CSV with header.
  // Otherwise treat every line as a bare username.
  const firstLineLower = lines[0].toLowerCase();
  const hasHeader = firstLineLower.split(',').map((h) => h.trim()).includes('username');

  if (hasHeader) {
    const header = firstLineLower.split(',').map((h) => h.trim());
    const usernameIdx = header.indexOf('username');

    const rows: UserRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const username = cols[usernameIdx] ?? '';
      if (!username) throw new Error(`Row ${i + 1}: username is required.`);
      rows.push({ username });
    }

    if (rows.length === 0) throw new Error('CSV has a header but no data rows.');
    return rows;
  }

  // Headerless: each line is a username.
  return lines.map((username, i) => {
    if (!username) throw new Error(`Line ${i + 1}: username is required.`);
    return { username };
  });
}

function validateRow(row: UserRow, lineNum: number): string | null {
  if (!RESOURCE_ID_REGEX.test(row.username)) {
    return `Row ${lineNum}: username "${row.username}" is invalid. Must be exactly 15 characters (letters, digits, hyphens).`;
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
// DynamoDB
// ---------------------------------------------------------------------------

async function hasModels(dynamo: DynamoDBClient, tableName: string, username: string): Promise<boolean> {
  // Models are stored with:
  //   PK = "profile_{username}"   (ResourceType.PROFILE + _ + profileId, casing: none)
  //   SK begins_with "model_"     (ResourceType.MODEL + _ + modelId, casing: none)
  const response = await dynamo.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :modelPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `profile_${username}` },
        ':modelPrefix': { S: 'model_' },
      },
      Select: 'COUNT',
      Limit: 1,
    }),
  );

  return (response.Count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const csvPath = args.csv as string | undefined;
  const userPoolIdArg = args['user-pool-id'] as string | undefined;
  const namespace = args.namespace as string | undefined;
  const tableNameArg = args['table-name'] as string | undefined;
  const region = (args.region as string | undefined) ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION;
  const isDryRun = args['dry-run'] === true;

  // ── Validate required args ────────────────────────────────────────────────

  if (!csvPath) {
    console.error('Error: --csv <file> is required.');
    process.exit(1);
  }

  if (!userPoolIdArg && !namespace) {
    console.error('Error: provide either --user-pool-id <id> or --namespace <ns>.');
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

  const seen = new Set<string>();
  const validationErrors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const err = validateRow(rows[i], i + 2);
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

  // ── Resolve Cognito User Pool ID ─────────────────────────────────────────

  const cognitoClient = new CognitoIdentityProviderClient({ region });

  let userPoolId: string;
  if (userPoolIdArg) {
    userPoolId = userPoolIdArg;
  } else {
    console.log(`Discovering user pool for namespace "${namespace}"…`);
    try {
      userPoolId = await discoverUserPoolId(cognitoClient, namespace as string);
      console.log(`Found user pool: ${userPoolId}`);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // ── Resolve DynamoDB table name ───────────────────────────────────────────

  const tableName = tableNameArg ?? (namespace ? `${namespace}-${DYNAMO_TABLE_SUFFIX}` : undefined);
  if (!tableName) {
    console.error('Error: cannot determine DynamoDB table name. Provide --table-name or --namespace.');
    process.exit(1);
  }

  const dynamoClient = new DynamoDBClient({ region });

  // ── Print plan ───────────────────────────────────────────────────────────

  console.log('');
  console.log(`User pool  : ${userPoolId}`);
  console.log(`DynamoDB   : ${tableName}`);
  console.log(`Users      : ${rows.length}`);
  if (isDryRun) console.log('Mode       : DRY RUN (no changes will be made)');
  console.log('');

  // ── Process users ─────────────────────────────────────────────────────────

  const results: UserResult[] = [];

  for (const row of rows) {
    // Check whether the user has any models in DynamoDB.
    let userHasModels: boolean;
    try {
      userHasModels = await hasModels(dynamoClient, tableName, row.username);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      console.error(`  ${row.username}: failed to query DynamoDB — ${message}`);
      results.push({ username: row.username, action: 'delete', status: 'failed', error: message });
      continue;
    }

    const verb = userHasModels ? 'disable' : 'delete';

    if (isDryRun) {
      const label = userHasModels ? 'has models → would disable' : 'no models → would delete';
      console.log(`  [dry-run] ${row.username}  (${label})`);
      results.push({ username: row.username, action: `dry-run-${verb}`, status: 'ok' });
      continue;
    }

    process.stdout.write(`  ${verb === 'disable' ? 'Disabling' : 'Deleting '} ${row.username}… `);
    try {
      if (userHasModels) {
        await cognitoClient.send(
          new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: row.username }),
        );
      } else {
        try {
          await cognitoClient.send(
            new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: row.username }),
          );
        } catch (e) {
          if ((e as { name?: string }).name !== 'UserNotFoundException') throw e;
          // User already absent from Cognito — still clean up DynamoDB below.
        }
        // Remove the DynamoDB profile item (profile_{username} / profile).
        await dynamoClient.send(
          new DeleteItemCommand({
            TableName: tableName,
            Key: {
              pk: { S: `profile_${row.username}` },
              sk: { S: 'profile' },
            },
          }),
        );
      }
      process.stdout.write('OK\n');
      results.push({ username: row.username, action: verb, status: 'ok' });
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      process.stdout.write('FAILED\n');
      results.push({ username: row.username, action: verb, status: 'failed', error: message });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  if (!isDryRun) {
    const deleted = results.filter((r) => r.action === 'delete' && r.status === 'ok').length;
    const disabled = results.filter((r) => r.action === 'disable' && r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'failed');

    console.log('');
    console.log(`Done. ${deleted} deleted, ${disabled} disabled (${failed.length} failed).`);

    if (failed.length > 0) {
      console.log('');
      console.log('Failures:');
      for (const r of failed) {
        console.log(`  ${r.username}: ${r.error}`);
      }
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
