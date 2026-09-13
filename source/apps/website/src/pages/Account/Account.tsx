// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { fetchUserAttributes, updateUserAttributes } from 'aws-amplify/auth';
import { getNames, registerLocale } from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getUserEmail } from '#utils/authUtils.js';

import ChangePasswordModal from './components/ChangePasswordModal/ChangePasswordModal';
import DeleteAccountModal from './components/DeleteAccountModal/DeleteAccountModal';

const Account = () => {
  const { t } = useTranslation('account');
  const [isDeleteAccountModalOpen, setIsDeleteAccountModalOpen] = useState(false);
  const [isChangePasswordModalOpen, setIsChangePasswordModalOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | undefined>('');
  const [userCountry, setUserCountry] = useState<string | null>(null);
  const [pendingCountry, setPendingCountry] = useState<string | null>(null);
  const [isSavingCountry, setIsSavingCountry] = useState(false);

  const countryOptions = useMemo(() => {
    registerLocale(enLocale);
    return Object.entries(getNames('en', { select: 'official' })).map(([value, label]) => ({
      value,
      label: label as string,
    }));
  }, []);

  const fetchUserEmail = async () => {
    const email = await getUserEmail();
    setUserEmail(email);
  };

  const fetchUserCountry = async () => {
    const attrs = await fetchUserAttributes();
    const code = (attrs['custom:countryCode'] as string | undefined) ?? null;
    setUserCountry(code);
    setPendingCountry(code);
  };

  useEffect(() => {
    fetchUserEmail().catch(() => setUserEmail(undefined));
    fetchUserCountry().catch(() => null);
  }, []);

  const handleSaveCountry = async () => {
    if (!pendingCountry) return;
    setIsSavingCountry(true);
    await updateUserAttributes({ userAttributes: { 'custom:countryCode': pendingCountry } });
    setUserCountry(pendingCountry);
    setIsSavingCountry(false);
  };

  const handleDeleteAccountClick = () => {
    setIsDeleteAccountModalOpen(true);
  };

  const handleChangePasswordClick = () => {
    setIsChangePasswordModalOpen(true);
  };

  return (
    <ContentLayout
      defaultPadding
      header={
        <Header
          data-testid="accountHeader"
          variant="h1"
          info={<Link variant="info">{t('info')}</Link>}
          description={t('description')}
        >
          {t('header')}
        </Header>
      }
    >
      <Container header={<Header variant="h2">{t('yourAccountInfo')}</Header>}>
        <SpaceBetween size="l">
          <SpaceBetween size="xxs">
            <Box variant="p" padding="n" fontWeight="bold">
              {t('yourEmail')}
            </Box>
            <Box variant="p">{userEmail}</Box>
          </SpaceBetween>
          <SpaceBetween size="xxs">
            <Box variant="p" padding="n" fontWeight="bold">
              {t('yourPassword')}
            </Box>
            <ColumnLayout columns={4}>
              <Box fontSize="body-m">{'xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'}</Box>
              <Link onFollow={handleChangePasswordClick}>{t('changePassword')}</Link>
            </ColumnLayout>
          </SpaceBetween>
          <SpaceBetween size="xxs">
            <Box variant="p" padding="n" fontWeight="bold">
              {t('yourCountry')}
            </Box>
            <ColumnLayout columns={4}>
              <FormField>
                <Select
                  filteringType="auto"
                  selectedOption={
                    pendingCountry ? (countryOptions.find((o) => o.value === pendingCountry) ?? null) : null
                  }
                  onChange={({ detail }) => setPendingCountry(detail.selectedOption.value ?? null)}
                  options={countryOptions}
                  placeholder={t('countryPlaceholder')}
                />
              </FormField>
              <Button
                loading={isSavingCountry}
                disabled={!pendingCountry || pendingCountry === userCountry}
                onClick={handleSaveCountry}
              >
                {t('saveCountry')}
              </Button>
            </ColumnLayout>
          </SpaceBetween>
          <Button variant="normal" onClick={handleDeleteAccountClick}>
            {t('deleteYourAccount')}
          </Button>
        </SpaceBetween>
      </Container>
      <ChangePasswordModal isOpen={isChangePasswordModalOpen} setIsOpen={setIsChangePasswordModalOpen} />
      <DeleteAccountModal isOpen={isDeleteAccountModalOpen} setIsOpen={setIsDeleteAccountModalOpen} />
    </ContentLayout>
  );
};

export default Account;
