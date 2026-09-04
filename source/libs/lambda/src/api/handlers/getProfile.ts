// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Operation } from '@aws-smithy/server-common';
import { DynamoDBItemAttribute, profileDao } from '@deepracer-indy/database';
import {
  getGetProfileHandler,
  GetProfileServerInput,
  GetProfileServerOutput,
  NotFoundError,
} from '@deepracer-indy/typescript-server-client';
import { logger, metricsLogger } from '@deepracer-indy/utils';

import { globalSettingsHelper } from '../../utils/GlobalSettingsHelper.js';
import type { HandlerContext } from '../types/apiGatewayHandlerContext.js';
import { getApiGatewayHandler } from '../utils/apiGateway.js';
import { instrumentOperation } from '../utils/instrumentation/instrumentOperation.js';

/**
 * Just-in-time profile provisioning.
 *
 * Called when a user successfully authenticates (Cognito + Identity Pool) but
 * has no DynamoDB profile record yet. This happens for:
 *  - Admin-created users (AdminCreateUser bypasses preSignUp trigger)
 *  - SSO/federated users from an external UserPool
 *  - Any path where the preSignUp trigger did not run or did not write the record
 *
 * Creates a minimal profile using the same quota defaults as the preSignUp trigger.
 * The user can update their alias and other fields after first login.
 */
async function provisionProfile(profileId: string) {
  logger.warn('Profile not found — JIT provisioning a new profile', { profileId });

  const newUserLimits = (await globalSettingsHelper.getGlobalSetting('usageQuotas.newUser')) as {
    newUserComputeMinutesLimit: number;
    newUserModelCountLimit: number;
  } | null;

  const maxTotalComputeMinutes = Number(newUserLimits?.newUserComputeMinutesLimit ?? 240);
  const maxModelCount = Number(newUserLimits?.newUserModelCountLimit ?? 10);

  const profileItem = await profileDao.create({
    profileId: profileId,
    // Use the Cognito account ID as the initial alias — user can change it from the profile page.
    alias: profileId,
    [DynamoDBItemAttribute.MAX_TOTAL_COMPUTE_MINUTES]: maxTotalComputeMinutes,
    [DynamoDBItemAttribute.MAX_MODEL_COUNT]: maxModelCount,
    [DynamoDBItemAttribute.CREATED_AT]: new Date().toISOString(),
  });

  metricsLogger.logCreateUser();
  return profileItem;
}

export const GetProfileOperation: Operation<GetProfileServerInput, GetProfileServerOutput, HandlerContext> = async (
  _input,
  context,
) => {
  const { profileId } = context;

  let profileItem;
  try {
    profileItem = await profileDao.load({ profileId });
  } catch (err) {
    if (err instanceof NotFoundError) {
      profileItem = await provisionProfile(profileId);
    } else {
      throw err;
    }
  }

  metricsLogger.logUserLogin({
    profileId: profileItem.profileId,
  });

  return {
    profile: {
      alias: profileItem.alias,
      avatar: profileItem.avatar,
      profileId: profileItem.profileId,
      emailAddress: profileItem.emailAddress,
      computeMinutesUsed: profileItem.computeMinutesUsed,
      computeMinutesQueued: profileItem.computeMinutesQueued,
      maxTotalComputeMinutes: profileItem.maxTotalComputeMinutes,
      modelCount: profileItem.modelCount,
      maxModelCount: profileItem.maxModelCount,
    },
  } satisfies GetProfileServerOutput;
};

export const lambdaHandler = getApiGatewayHandler(getGetProfileHandler(instrumentOperation(GetProfileOperation)));
