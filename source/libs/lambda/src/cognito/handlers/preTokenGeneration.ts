// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PreTokenGenerationTriggerHandler } from 'aws-lambda';

import { instrumentHandler } from '../../utils/instrumentation/instrumentHandler.js';

/**
 * Maps DRoA Cognito group names to their DREM equivalents.
 * Injected as virtual groups into the ID token so DREM's AppSync
 * group-based authorization works without requiring dual group membership.
 */
const GROUP_ALIAS_MAP: Record<string, string> = {
  'dr-admins': 'admin',
  'dr-race-facilitators': 'operator',
  'dr-racers': 'racer',
  'dr-commentator': 'commentator',
  'dr-registration': 'registration',
};

export const PreTokenGeneration: PreTokenGenerationTriggerHandler = async (event) => {
  const existingGroups = event.request.groupConfiguration.groupsToOverride ?? [];

  const aliases = existingGroups.map((g) => GROUP_ALIAS_MAP[g]).filter((alias): alias is string => alias !== undefined);

  if (aliases.length > 0) {
    const merged = [...new Set([...existingGroups, ...aliases])];
    return {
      ...event,
      response: {
        claimsOverrideDetails: {
          groupOverrideDetails: {
            groupsToOverride: merged,
          },
        },
      },
    };
  }

  return event;
};

export const lambdaHandler = instrumentHandler(PreTokenGeneration);
