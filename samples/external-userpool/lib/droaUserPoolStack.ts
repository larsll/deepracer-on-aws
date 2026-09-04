// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DroaUserPoolStack
 *
 * Creates a Cognito UserPool that satisfies the DeepRacer on AWS (DRoA)
 * external UserPool contract (see docs/external-userpool-contract.md).
 *
 * After deploying this stack, use the exported outputs to deploy the main DRoA stack:
 *
 *   cdk deploy --context externalUserPoolId=<UserPoolId output> \
 *              --context externalUserPoolClientId=<UserPoolClientId output>
 *
 * What this stack provisions
 * ──────────────────────────
 *  • Cognito UserPool with required custom attributes and password policy
 *  • Five required Cognito groups (dr-admins, dr-race-facilitators, dr-racers,
 *    dr-commentator, dr-registration)
 *  • preSignUp trigger Lambda   — creates the DynamoDB profile for new users
 *  • postConfirmation trigger   — adds confirmed users to dr-racers group
 *  • preTokenGeneration trigger — injects DREM-compatible group aliases into tokens
 *  • App Client (no secret, USER_SRP_AUTH + USER_PASSWORD_AUTH)
 *
 * What this stack does NOT provision (remains the DRoA stack's responsibility)
 * ────────────────────────────────────────────────────────────────────────────
 *  • Cognito Identity Pool and IAM roles
 *  • API Gateway, Lambda API functions, DynamoDB table
 *  • S3 buckets, CloudFront distribution
 *  • EventBridge rules for group/email change sync
 */

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  CfnUserPoolGroup,
  StringAttribute,
  UserPool,
  UserPoolClient,
  VerificationEmailStyle,
} from 'aws-cdk-lib/aws-cognito';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface DroaUserPoolStackProps extends StackProps {
  /**
   * DynamoDB table name that the DRoA stack will create.
   * The preSignUp trigger needs write access to create profiles.
   *
   * If you deploy this UserPool before the DRoA stack exists, leave this
   * undefined. The trigger will fail gracefully on the first sign-up until
   * the DRoA table exists — or pass the table name once the DRoA stack is up.
   */
  droaTableName?: string;

  /**
   * Whether to include the preTokenGeneration trigger that injects DREM group aliases.
   * Set to true only if this UserPool will be used together with DREM.
   * @default false
   */
  enableDremGroupAliases?: boolean;

  /**
   * Removal policy for the UserPool and App Client.
   * Use RETAIN for production deployments.
   * @default RemovalPolicy.DESTROY (safe for samples and dev)
   */
  removalPolicy?: RemovalPolicy;
}

/** The five Cognito groups required by the DRoA Identity Pool role mapping. */
const DROA_GROUPS = [
  { name: 'dr-admins', description: 'DeepRacer on AWS — Admin users' },
  { name: 'dr-race-facilitators', description: 'DeepRacer on AWS — Race facilitators' },
  { name: 'dr-racers', description: 'DeepRacer on AWS — Racers' },
  { name: 'dr-commentator', description: 'DeepRacer on AWS — Commentators' },
  { name: 'dr-registration', description: 'DeepRacer on AWS — Registration desk' },
] as const;

export class DroaUserPoolStack extends Stack {
  /** The UserPool ID to pass to DRoA via --context externalUserPoolId */
  readonly userPoolId: string;
  /** The App Client ID to pass to DRoA via --context externalUserPoolClientId */
  readonly userPoolClientId: string;

  constructor(scope: Construct, id: string, props: DroaUserPoolStackProps = {}) {
    super(scope, id, props);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.DESTROY;

    // ── Trigger Lambdas ────────────────────────────────────────────────────

    // preSignUp: creates the DynamoDB profile record for the new user.
    // The DRoA table name must be provided so the Lambda can write to it.
    const preSignUpFn = new NodejsFunction(this, 'PreSignUpFunction', {
      description: 'DRoA preSignUp trigger — creates DynamoDB profile for new users',
      entry: path.join(__dirname, 'lambdas/preSignUp.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      environment: {
        DROA_TABLE_NAME: props.droaTableName ?? '',
      },
    });

    // Grant write access to the DRoA DynamoDB table if the table name is known
    if (props.droaTableName) {
      preSignUpFn.addToRolePolicy(
        new PolicyStatement({
          actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
          resources: [
            `arn:${this.partition}:dynamodb:${this.region}:${this.account}:table/${props.droaTableName}`,
          ],
        }),
      );
    }

    // postConfirmation: adds the confirmed user to the dr-racers group.
    const postConfirmationFn = new NodejsFunction(this, 'PostConfirmationFunction', {
      description: 'DRoA postConfirmation trigger — adds user to dr-racers group',
      entry: path.join(__dirname, 'lambdas/postConfirmation.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
    });

    // postConfirmation needs to call AdminAddUserToGroup on this pool
    postConfirmationFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['cognito-idp:AdminAddUserToGroup'],
        // Pool ARN is not known until after synthesis; use a wildcard scoped to this account/region
        resources: [
          `arn:${this.partition}:cognito-idp:${this.region}:${this.account}:userpool/${this.region}_*`,
        ],
      }),
    );

    // preTokenGeneration: injects DREM-compatible group aliases into the token.
    // Only included when enableDremGroupAliases is true.
    const preTokenGenerationFn = props.enableDremGroupAliases
      ? new NodejsFunction(this, 'PreTokenGenerationFunction', {
          description: 'DRoA preTokenGeneration trigger — injects DREM group aliases into tokens',
          entry: path.join(__dirname, 'lambdas/preTokenGeneration.ts'),
          runtime: Runtime.NODEJS_20_X,
          timeout: Duration.seconds(5),
        })
      : undefined;

    // ── UserPool ───────────────────────────────────────────────────────────

    const userPool = new UserPool(this, 'UserPool', {
      userPoolName: 'droa-external-userpool',

      // Sign-in: email primary, username and preferred username also allowed
      signInAliases: {
        email: true,
        username: true,
        preferredUsername: true,
      },
      signInCaseSensitive: false,

      // Self sign-up disabled by default — users are invited by an admin.
      // Set to true if you want open registration.
      selfSignUpEnabled: false,

      // Email verification (used when selfSignUpEnabled is true)
      userVerification: {
        emailSubject: 'Verify your DeepRacer on AWS account',
        emailBody: 'Your verification code is {####}',
        emailStyle: VerificationEmailStyle.CODE,
      },

      // Admin invite email
      userInvitation: {
        emailSubject: 'Welcome to DeepRacer on AWS',
        emailBody:
          'Hello,<br><br>You have been invited to join DeepRacer on AWS. ' +
          'Your temporary password is: {####}<br><br>' +
          'You will be asked to set a new password on your first login.<br><br>' +
          '<i>Account: {username}</i>',
      },

      // Password policy (matches DRoA owned-pool defaults)
      passwordPolicy: {
        minLength: 8,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },

      accountRecovery: AccountRecovery.EMAIL_ONLY,

      // ── Required custom attributes ────────────────────────────────────
      // These MUST exist. Cognito does not allow adding attributes after pool creation.
      customAttributes: {
        racerName: new StringAttribute({ mutable: true }),
        countryCode: new StringAttribute({ mutable: true }),
      },

      // ── Trigger Lambdas ───────────────────────────────────────────────
      lambdaTriggers: {
        preSignUp: preSignUpFn,
        postConfirmation: postConfirmationFn,
        ...(preTokenGenerationFn ? { preTokenGeneration: preTokenGenerationFn } : {}),
      },
    });

    userPool.applyRemovalPolicy(removalPolicy);

    // ── Groups ─────────────────────────────────────────────────────────────
    // All five groups required by the DRoA Identity Pool role mapping rules.

    for (const group of DROA_GROUPS) {
      new CfnUserPoolGroup(this, `Group-${group.name}`, {
        userPoolId: userPool.userPoolId,
        groupName: group.name,
        description: group.description,
      });
    }

    // ── App Client ─────────────────────────────────────────────────────────
    // Public client (no secret) for browser-based SPA use.

    const userPoolClient = new UserPoolClient(this, 'WebClient', {
      userPool,
      userPoolClientName: 'droa-web-client',
      generateSecret: false, // Must be false — DRoA frontend is a public SPA
      authFlows: {
        userSrp: true,       // Secure Remote Password — recommended
        userPassword: true,  // Direct password — for CLI/testing convenience
      },
      refreshTokenValidity: Duration.days(1),
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
    });

    userPoolClient.applyRemovalPolicy(removalPolicy);

    this.userPoolId = userPool.userPoolId;
    this.userPoolClientId = userPoolClient.userPoolClientId;

    // ── Outputs ────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Pass to DRoA: --context externalUserPoolId=<value>',
      exportName: 'DroaExternalUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Pass to DRoA: --context externalUserPoolClientId=<value>',
      exportName: 'DroaExternalUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: userPool.userPoolArn,
      description: 'UserPool ARN — useful for granting IAM permissions',
      exportName: 'DroaExternalUserPoolArn',
    });

    new cdk.CfnOutput(this, 'DeployCommand', {
      value: [
        'cdk deploy \\',
        `  --context externalUserPoolId=${userPool.userPoolId} \\`,
        `  --context externalUserPoolClientId=${userPoolClient.userPoolClientId}`,
      ].join('\n'),
      description: 'Copy-paste command to deploy the main DRoA stack using this pool',
    });
  }
}
