// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Button from '@cloudscape-design/components/button';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Modal from '@cloudscape-design/components/modal';
import Select, { SelectProps } from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { getNames, registerLocale } from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';
import { useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import * as Yup from 'yup';
import { yupResolver } from '@hookform/resolvers/yup';

import InputField from '#components/FormFields/InputField';
import { useAppDispatch } from '#hooks/useAppDispatch';
import { useCreateBasicProfileMutation } from '#services/deepRacer/profileApi';
import { displayErrorNotification, displaySuccessNotification } from '#store/notifications/notificationsSlice';

interface NewBasicUserModalProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
}

interface NewBasicUserFormValues {
  racerName: string;
}

const validationSchema = Yup.object().shape({
  racerName: Yup.string()
    .min(2, 'Racer name must be at least 2 characters')
    .max(64, 'Racer name must be at most 64 characters')
    .required('Racer name is required'),
});

const NewBasicUserModal = ({ isOpen, setIsOpen }: NewBasicUserModalProps) => {
  const dispatch = useAppDispatch();
  const [createBasicProfile, { isLoading: isCreating }] = useCreateBasicProfileMutation();

  const [countryOption, setCountryOption] = useState<SelectProps.Option | null>(null);
  const [countryError, setCountryError] = useState<string | undefined>(undefined);

  const countryOptions = useMemo<SelectProps.Option[]>(() => {
    registerLocale(enLocale);
    return Object.entries(getNames('en', { select: 'official' })).map(([code, name]) => ({
      label: name,
      value: code,
    }));
  }, []);

  const {
    control,
    handleSubmit: handleFormSubmit,
    reset,
    trigger: validateForm,
  } = useForm<NewBasicUserFormValues>({
    defaultValues: { racerName: '' },
    resolver: yupResolver(validationSchema),
    mode: 'onBlur',
  });

  const racerNameValue = useWatch({ control, name: 'racerName' });
  const isFormFilled = racerNameValue?.trim().length > 0 && countryOption !== null;

  const handleClose = () => {
    reset({ racerName: '' });
    setCountryOption(null);
    setCountryError(undefined);
    setIsOpen(false);
  };

  const handleSubmit = async (formValues: NewBasicUserFormValues) => {
    if (!countryOption?.value) {
      setCountryError('Country is required');
      return;
    }

    const isFormValid = await validateForm();
    if (!isFormValid) return;

    try {
      await createBasicProfile({
        alias: formValues.racerName.trim(),
        country: countryOption.value,
      }).unwrap();

      dispatch(
        displaySuccessNotification({
          content: `Basic user "${formValues.racerName}" created successfully.`,
        }),
      );

      reset({ racerName: '' });
      setCountryOption(null);
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to create basic user');
      dispatch(
        displayErrorNotification({
          content: 'Failed to create basic user. Please try again.',
        }),
      );
    }
  };

  return (
    <Modal
      onDismiss={handleClose}
      visible={isOpen}
      closeAriaLabel="Close modal"
      size="medium"
      header="New basic user"
    >
      <form onSubmit={handleFormSubmit(handleSubmit)}>
        <Form
          actions={
            <SpaceBetween size="xs" direction="horizontal">
              <Button formAction="none" onClick={handleClose}>
                Cancel
              </Button>
              <Button formAction="submit" variant="primary" disabled={!isFormFilled} loading={isCreating}>
                Create
              </Button>
            </SpaceBetween>
          }
        >
          <SpaceBetween size="l">
            <InputField
              control={control}
              name="racerName"
              label="Racer name"
              description="The display name for this participant."
              placeholder="Enter racer name"
            />
            <FormField
              label="Country"
              description="The country this participant represents."
              errorText={countryError}
            >
              <Select
                selectedOption={countryOption}
                onChange={({ detail }) => {
                  setCountryOption(detail.selectedOption);
                  setCountryError(undefined);
                }}
                options={countryOptions}
                selectedAriaLabel="Selected"
                filteringType="auto"
                placeholder="Select a country"
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </form>
    </Modal>
  );
};

export default NewBasicUserModal;
