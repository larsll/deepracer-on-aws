// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  profileDao,
  TEST_GLOBAL_CONFIG_NEW_USER,
  TEST_ITEM_NOT_FOUND_ERROR,
  TEST_PROFILE_ITEM,
} from '@deepracer-indy/database';
import { metricsLogger } from '@deepracer-indy/utils';

import { globalSettingsHelper } from '../../../utils/GlobalSettingsHelper.js';
import { TEST_OPERATION_CONTEXT } from '../../constants/testConstants.js';
import { GetProfileOperation } from '../getProfile.js';

vi.mock('../../../utils/GlobalSettingsHelper.js');

describe('GetProfile operation', () => {
  const mockGlobalSettingsHelper = vi.mocked(globalSettingsHelper);

  beforeEach(() => {
    mockGlobalSettingsHelper.getGlobalSetting.mockImplementation((key: string) => {
      if (key === 'usageQuotas.newUser') {
        return Promise.resolve({ ...TEST_GLOBAL_CONFIG_NEW_USER });
      }
      return Promise.resolve(null);
    });
    vi.spyOn(metricsLogger, 'logCreateUser').mockImplementation(() => undefined);
  });

  it('should return profile in response', async () => {
    vi.spyOn(profileDao, 'load').mockResolvedValue(TEST_PROFILE_ITEM);

    const output = await GetProfileOperation({}, TEST_OPERATION_CONTEXT);

    expect(output.profile).toBeDefined();
    expect(output.profile.profileId).toEqual(TEST_PROFILE_ITEM.profileId);
    expect(output.profile.alias).toEqual(TEST_PROFILE_ITEM.alias);
    expect(output.profile.avatar).toEqual(TEST_PROFILE_ITEM.avatar);
    expect(output.profile.emailAddress).toEqual(TEST_PROFILE_ITEM.emailAddress);
    expect(output.profile.computeMinutesUsed).toEqual(TEST_PROFILE_ITEM.computeMinutesUsed);
    expect(output.profile.computeMinutesQueued).toEqual(TEST_PROFILE_ITEM.computeMinutesQueued);
    expect(output.profile.maxTotalComputeMinutes).toEqual(TEST_PROFILE_ITEM.maxTotalComputeMinutes);
    expect(output.profile.modelCount).toEqual(TEST_PROFILE_ITEM.modelCount);
    expect(output.profile.maxModelCount).toEqual(TEST_PROFILE_ITEM.maxModelCount);
  });

  describe('JIT profile provisioning', () => {
    it('should create a profile when none exists and return it', async () => {
      vi.spyOn(profileDao, 'load').mockRejectedValueOnce(TEST_ITEM_NOT_FOUND_ERROR);
      vi.spyOn(profileDao, 'create').mockResolvedValue(TEST_PROFILE_ITEM);

      const output = await GetProfileOperation({}, TEST_OPERATION_CONTEXT);

      expect(profileDao.create).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: TEST_OPERATION_CONTEXT.profileId,
          alias: TEST_OPERATION_CONTEXT.profileId,
          maxTotalComputeMinutes: TEST_GLOBAL_CONFIG_NEW_USER.newUserComputeMinutesLimit,
          maxModelCount: TEST_GLOBAL_CONFIG_NEW_USER.newUserModelCountLimit,
          createdAt: expect.any(String),
        }),
      );
      expect(output.profile.profileId).toEqual(TEST_PROFILE_ITEM.profileId);
    });

    it('should use default quotas when AppConfig returns null', async () => {
      vi.spyOn(profileDao, 'load').mockRejectedValueOnce(TEST_ITEM_NOT_FOUND_ERROR);
      vi.spyOn(profileDao, 'create').mockResolvedValue(TEST_PROFILE_ITEM);
      mockGlobalSettingsHelper.getGlobalSetting.mockResolvedValue(null);

      await GetProfileOperation({}, TEST_OPERATION_CONTEXT);

      expect(profileDao.create).toHaveBeenCalledWith(
        expect.objectContaining({
          maxTotalComputeMinutes: 240,
          maxModelCount: 10,
        }),
      );
    });

    it('should rethrow non-NotFound errors', async () => {
      const serverError = new Error('DynamoDB connection failed');
      vi.spyOn(profileDao, 'load').mockRejectedValueOnce(serverError);
      const createSpy = vi.spyOn(profileDao, 'create');

      await expect(GetProfileOperation({}, TEST_OPERATION_CONTEXT)).rejects.toThrow('DynamoDB connection failed');
      expect(createSpy).not.toHaveBeenCalled();
    });
  });
});
