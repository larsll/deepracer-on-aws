// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Operation } from '@aws-smithy/server-common';
import { DynamoDBItemAttribute, generateBasicProfileId, profileDao, ResourceId } from '@deepracer-indy/database';
import {
  BadRequestError,
  CreateBasicProfileServerInput,
  CreateBasicProfileServerOutput,
  getCreateBasicProfileHandler,
  InternalFailureError,
} from '@deepracer-indy/typescript-server-client';
import { logger } from '@deepracer-indy/utils';

import { UserGroups } from '../../cognito/handlers/common/constants.js';
import { cognitoClient } from '../../utils/clients/cognitoClient.js';
import type { HandlerContext } from '../types/apiGatewayHandlerContext.js';
import { getApiGatewayHandler, isUserAdmin } from '../utils/apiGateway.js';
import { instrumentOperation } from '../utils/instrumentation/instrumentOperation.js';

const ALIAS_REGEX = /^[a-zA-Z0-9_\- ]{2,64}$/;
const COUNTRY_REGEX = /^[a-zA-Z\- ]{1,80}$/;

async function createCognitoUser(userPoolId: string, username: string, alias: string, country: string) {
  logger.info(`Creating basic Cognito user: username=${username}`);
  await cognitoClient.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      // Suppress the invitation email — basic users don't get a login invite
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        {
          Name: 'preferred_username',
          Value: alias.toLowerCase(),
        },
        {
          Name: 'custom:racerName',
          Value: alias,
        },
        {
          Name: 'custom:countryCode',
          Value: country,
        },
      ],
    }),
  );
}

async function addUserToGroup(userPoolId: string, username: string) {
  logger.info(`Adding basic user to group: ${UserGroups.RACERS}`);
  await cognitoClient.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: username,
      GroupName: UserGroups.RACERS,
    }),
  );
}

async function rollback(userPoolId: string, username: string) {
  // Best-effort cleanup — delete both Cognito user and DynamoDB profile.
  // The preSignUp Lambda creates the DynamoDB profile automatically when AdminCreateUser fires,
  // so we must clean it up here too.
  try {
    await cognitoClient.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
  } catch {
    logger.warn(`Cleanup: could not delete Cognito user ${username}`);
  }
  try {
    await profileDao.delete({ profileId: username as ResourceId });
  } catch {
    logger.warn(`Cleanup: could not delete DynamoDB profile ${username}`);
  }
}

export const CreateBasicProfileOperation: Operation<
  CreateBasicProfileServerInput,
  CreateBasicProfileServerOutput,
  HandlerContext
> = async (input, context) => {
  const { profileId: requestingProfileId } = context;

  const isAdmin = await isUserAdmin(requestingProfileId);
  if (!isAdmin) {
    throw new BadRequestError({ message: 'Only administrators can create basic user profiles' });
  }

  const { alias, country } = input;

  if (!ALIAS_REGEX.test(alias)) {
    throw new BadRequestError({
      message: 'Invalid racer name. Use 2–64 characters: letters, numbers, spaces, hyphens, or underscores.',
    });
  }

  if (!COUNTRY_REGEX.test(country)) {
    throw new BadRequestError({ message: 'Invalid country. Use 1–80 letters, spaces, or hyphens.' });
  }

  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) {
    throw new InternalFailureError({ message: 'Service configuration error.' });
  }

  // The profileId doubles as the Cognito username. The "dr-user-" prefix makes basic users
  // instantly recognisable in Cognito and CloudWatch logs without any other metadata.
  const username = generateBasicProfileId(); // e.g. "dr-user-Ab3dEfG" (15 chars)

  logger.info(`Creating basic user: alias=${alias}, country=${country}, profileId=${username}`);

  // 1. Create the Cognito user (suppressed — no invite email sent)
  try {
    await createCognitoUser(userPoolId, username, alias, country);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    throw new InternalFailureError({ message: 'Unable to create user account. Please try again.' });
  }

  // 2. Add to the racers group so they're visible in all the same Cognito group queries
  try {
    await addUserToGroup(userPoolId, username);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    await rollback(userPoolId, username);
    throw new InternalFailureError({ message: 'Unable to assign user role. Please try again.' });
  }

  // 3. Patch roleName and country onto the DynamoDB profile.
  //    The preSignUp Lambda fires on AdminCreateUser and creates the base profile automatically
  //    (with quotas, alias, avatar) but without roleName or country — so we patch those in.
  try {
    await profileDao.partialUpdate(
      { profileId: username as ResourceId },
      {
        [DynamoDBItemAttribute.COUNTRY]: country,
        [DynamoDBItemAttribute.ROLE_NAME]: UserGroups.RACERS,
      },
    );
  } catch (error) {
    if (error instanceof Error) {
      logger.error(JSON.stringify(error, Object.getOwnPropertyNames(error)));
    }
    await rollback(userPoolId, username);
    throw new InternalFailureError({ message: 'Unable to create user profile. Please try again.' });
  }

  return {
    message: `Basic user "${alias}" created successfully.`,
  };
};

export const lambdaHandler = getApiGatewayHandler(
  getCreateBasicProfileHandler(instrumentOperation(CreateBasicProfileOperation)),
);
