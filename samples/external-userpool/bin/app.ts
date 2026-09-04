#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { DroaUserPoolStack } from '../lib/droaUserPoolStack';

const app = new cdk.App();

new DroaUserPoolStack(app, 'DroaUserPoolStack', {
  description:
    'Sample Cognito UserPool that satisfies the DeepRacer on AWS external UserPool contract. ' +
    'Deploy this stack first, then use its outputs when deploying the main DRoA stack.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
