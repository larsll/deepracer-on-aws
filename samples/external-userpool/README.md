# DeepRacer on AWS — External UserPool Sample

This standalone CDK app creates a Cognito UserPool that satisfies the
[DRoA external UserPool contract](../../docs/external-userpool-contract.md).

Deploy it first, then use its outputs to deploy the main DRoA stack in
external-UserPool mode.

---

## What gets deployed

| Resource | Details |
|---|---|
| Cognito UserPool | `droa-external-userpool` with required custom attributes and password policy |
| Cognito Groups | `dr-admins`, `dr-race-facilitators`, `dr-racers`, `dr-commentator`, `dr-registration` |
| preSignUp Lambda | Creates the DRoA DynamoDB profile for new users |
| postConfirmation Lambda | Adds confirmed users to `dr-racers` group |
| preTokenGeneration Lambda | *(optional)* Injects DREM group aliases into tokens |
| App Client | Public SPA client (no secret), USER_SRP_AUTH + USER_PASSWORD_AUTH |

---

## Prerequisites

- Node.js ≥ 18
- AWS CDK v2 (`npm install -g aws-cdk`)
- AWS credentials configured

---

## Deploy

```bash
# Install dependencies
npm install

# Bootstrap your account/region (once per account)
cdk bootstrap

# Deploy the UserPool stack
cdk deploy

# With DREM group alias support enabled:
cdk deploy --context enableDremGroupAliases=true

# Specifying the DRoA DynamoDB table name (required for profile creation):
cdk deploy --context droaTableName=<your-droa-table-name>
```

The deploy output will print a ready-made command for the main DRoA stack:

```
Outputs:
DroaUserPoolStack.UserPoolId         = eu-west-1_XXXXXXXXX
DroaUserPoolStack.UserPoolClientId   = XXXXXXXXXXXXXXXXXXXXXXXXXX
DroaUserPoolStack.DeployCommand      =
  cdk deploy \
    --context externalUserPoolId=eu-west-1_XXXXXXXXX \
    --context externalUserPoolClientId=XXXXXXXXXXXXXXXXXXXXXXXXXX
```

Copy and run that command from the **main DRoA repository root**.

---

## Order of operations

```
1. Deploy this sample stack  (creates UserPool)
         ↓
2. Note the DRoA DynamoDB table name from the main DRoA stack config
         ↓
3. Re-deploy this sample stack with --context droaTableName=<name>
   (grants the preSignUp Lambda write access to the table)
         ↓
4. Deploy the main DRoA stack with externalUserPoolId + externalUserPoolClientId
```

If you deploy the main DRoA stack first and get the table name from its outputs,
you can skip step 3 — just include `droaTableName` on the first deploy.

---

## Tear down

```bash
cdk destroy
```

> **Warning:** The UserPool has `RemovalPolicy.DESTROY` by default. All user accounts
> will be permanently deleted. For production, change the `removalPolicy` prop to
> `RemovalPolicy.RETAIN` and delete the pool manually when you are ready.

---

## Adapting this sample

| Need | Change |
|---|---|
| Keep existing users from a corporate pool | Don't use this sample — configure your pool to meet the contract manually |
| Enable self sign-up | Set `selfSignUpEnabled: true` in `droaUserPoolStack.ts` |
| Add an external IdP (SAML/OIDC) federated into this pool | Add a `UserPoolIdentityProvider` and a hosted UI domain to `droaUserPoolStack.ts` |
| Use SES for email delivery | Add an `email` config with `emailSendingAccount: 'DEVELOPER'` and `sourceArn` |
| Production removal policy | Pass `removalPolicy: RemovalPolicy.RETAIN` to the stack |
