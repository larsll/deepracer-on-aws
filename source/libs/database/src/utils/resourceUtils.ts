// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepRacerIndyAppConfig } from '@deepracer-indy/config';
import { customAlphabet, urlAlphabet } from 'nanoid';

import type { ResourceId } from '../types/resource.js';

/**
 * - "_" is not accepted in resource names by some AWS services
 * - "-" is used as our workflow job identifier separator (in addition to making IDs frustrating to copy+paste)
 */
const awsSafeAlphabet = urlAlphabet.replace('_', '').replace('-', '');
const nanoid = customAlphabet(awsSafeAlphabet, deepRacerIndyAppConfig.dynamoDB.resourceIdLength);

/**
 * Generates a secure URL-friendly unique ID typed as a special string.
 */
export const generateResourceId = () => {
  return nanoid() as ResourceId;
};

/**
 * Prefix for basic (display-only) user IDs. Combined with a random suffix it
 * produces exactly 15 characters matching RESOURCE_ID_REGEX.
 *
 * Lowercase-only alphabet is intentional: ElectroDB lowercases composite key
 * values when building the DynamoDB PK, so the stored attribute value and the
 * PK must use the same case to ensure deletes target the correct item.
 */
const BASIC_USER_PREFIX = 'dr-user-';
const basicUserSuffixLength = deepRacerIndyAppConfig.dynamoDB.resourceIdLength - BASIC_USER_PREFIX.length; // 7
const lowercaseAlphanumeric = 'abcdefghijklmnopqrstuvwxyz0123456789';
const basicNanoid = customAlphabet(lowercaseAlphanumeric, basicUserSuffixLength);

/**
 * Generates a recognisable resource ID for basic (no-login) user profiles.
 * Format: "dr-user-" + 7 lowercase alphanumeric chars = 15 chars total.
 * Example: "dr-user-ab3de7g"
 */
export const generateBasicProfileId = () => {
  return (BASIC_USER_PREFIX + basicNanoid()) as ResourceId;
};
