// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * preSignUp Cognito trigger
 *
 * Fired before a new user sign-up is accepted. Creates the user's profile record
 * in the DRoA DynamoDB table so the rest of the application can find them.
 *
 * Contract requirement: this trigger satisfies the preSignUp requirement defined in
 * docs/external-userpool-contract.md.
 *
 * Environment variables:
 *   DROA_TABLE_NAME — name of the DRoA DynamoDB table (set at deploy time)
 */

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { PreSignUpTriggerEvent } from 'aws-lambda';

const dynamo = new DynamoDBClient({});

export const handler = async (event: PreSignUpTriggerEvent): Promise<PreSignUpTriggerEvent> => {
  const tableName = process.env.DROA_TABLE_NAME;

  if (!tableName) {
    console.warn('DROA_TABLE_NAME not set — skipping profile creation');
    return event;
  }

  const { userPoolId, userName } = event;
  const email = event.request.userAttributes.email ?? '';

  // Username must be alphanumeric + hyphens/underscores (mirrors the owned-pool preSignUp check)
  const usernamePattern = /^[a-zA-Z0-9_-]+$/;
  if (!usernamePattern.test(userName)) {
    throw new Error(
      `Invalid username "${userName}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
    );
  }

  // Create the profile record. Use a conditional write so a repeated trigger
  // invocation (e.g. retry) is idempotent.
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          pk: { S: `USER#${userName}` },
          sk: { S: 'PROFILE' },
          userId: { S: userName },
          email: { S: email },
          userPoolId: { S: userPoolId },
          // Custom attributes — populated empty; updated on first login or profile edit
          racerName: { S: event.request.userAttributes?.['custom:racerName'] ?? '' },
          countryCode: { S: event.request.userAttributes['custom:countryCode'] ?? '' },
          createdAt: { S: new Date().toISOString() },
        },
        // Don't overwrite if the profile already exists (idempotent)
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    console.log(`Profile created for user: ${userName}`);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.log(`Profile already exists for user: ${userName} — skipping`);
    } else {
      // Rethrow — sign-up will be blocked and the error surfaced to the caller
      throw err;
    }
  }

  return event;
};
