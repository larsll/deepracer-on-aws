// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * postConfirmation Cognito trigger
 *
 * Fired after a user confirms their account (email verification or admin confirmation).
 * Adds the user to the dr-racers group so the DRoA Identity Pool can assign them
 * the RacerRole IAM role.
 *
 * Contract requirement: this trigger satisfies the postConfirmation requirement defined in
 * docs/external-userpool-contract.md.
 */

import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';

const cognito = new CognitoIdentityProviderClient({});

const DEFAULT_GROUP = 'dr-racers';

export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  const { userPoolId, userName } = event;

  // Only run on the ConfirmSignUp sub-trigger (not ForgotPassword confirmation)
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event;
  }

  try {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: userName,
        GroupName: DEFAULT_GROUP,
      }),
    );
    console.log(`Added user "${userName}" to group "${DEFAULT_GROUP}"`);
  } catch (err) {
    // Log but do not fail — a missing group assignment can be corrected manually
    // and is less disruptive than blocking the entire confirmation flow.
    console.error(`Failed to add user "${userName}" to group "${DEFAULT_GROUP}":`, err);
  }

  return event;
};
