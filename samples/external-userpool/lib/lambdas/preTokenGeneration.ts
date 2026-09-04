// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * preTokenGeneration Cognito trigger
 *
 * Fired on every token issuance (sign-in, token refresh).
 * Injects DREM-compatible group aliases into the ID token as an additional claim
 * so that DREM's AppSync group-based authorisation can recognise DRoA users.
 *
 * Mapping:
 *   dr-admins            → admin
 *   dr-race-facilitators → operator
 *   dr-racers            → racer
 *   dr-commentator       → commentator
 *   dr-registration      → registration
 *
 * Contract requirement: this trigger satisfies the optional preTokenGeneration
 * requirement defined in docs/external-userpool-contract.md. Only deploy this
 * trigger when DREM integration is needed (set enableDremGroupAliases: true in
 * the DroaUserPoolStack props).
 */

import type { PreTokenGenerationTriggerEvent } from 'aws-lambda';

/** Maps DRoA Cognito group names to DREM AppSync group aliases. */
const GROUP_ALIAS_MAP: Record<string, string> = {
  'dr-admins': 'admin',
  'dr-race-facilitators': 'operator',
  'dr-racers': 'racer',
  'dr-commentator': 'commentator',
  'dr-registration': 'registration',
};

export const handler = async (
  event: PreTokenGenerationTriggerEvent,
): Promise<PreTokenGenerationTriggerEvent> => {
  const cognitoGroups: string[] =
    event.request.groupConfiguration?.groupsToOverride ?? [];

  // Translate each DRoA group to its DREM alias; drop any groups that have no mapping
  const dremGroups = cognitoGroups
    .map((g) => GROUP_ALIAS_MAP[g])
    .filter((alias): alias is string => alias !== undefined);

  // Inject the DREM group aliases as an extra claim in the ID token.
  // The claim name matches what DREM's AppSync authoriser expects.
  event.response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride: {
        'custom:dremGroups': dremGroups.join(','),
      },
      groupOverrideDetails: {
        groupsToOverride: cognitoGroups,
      },
    },
  };

  return event;
};
