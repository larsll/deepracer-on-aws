# External UserPool Contract

DeepRacer on AWS (DRoA) can operate with either a **self-provisioned** Cognito UserPool (the default) or an **externally-managed** UserPool — for example one provided by a corporate SSO setup, DREM, or any other Cognito-compatible identity platform.

When you supply an external UserPool, the DRoA CDK stack imports it by reference rather than creating one. The stack's Identity Pool, IAM roles, API Gateway, and all application logic remain fully owned and managed by DRoA. However, **the external UserPool must satisfy this contract** before you deploy the DRoA stack against it.

---

## How to use an external UserPool

Pass two CDK context variables at synth/deploy time:

```bash
cdk deploy \
  --context externalUserPoolId=eu-west-1_XXXXXXXXX \
  --context externalUserPoolClientId=XXXXXXXXXXXXXXXXXXXXXXXXXX
```

| Context key | Description |
|---|---|
| `externalUserPoolId` | The full Cognito UserPool ID, e.g. `eu-west-1_AbCdEfGhI` |
| `externalUserPoolClientId` | The App Client ID from the external pool to use for this deployment |

When neither key is set (the default), DRoA creates and fully manages its own UserPool.

---

## Requirements

### 1. Cognito Groups

The following groups **must exist** in the external pool before deployment. They control Identity Pool role mapping and therefore what API routes each user can call.

| Group name | Purpose |
|---|---|
| `dr-admins` | Full API access — system administrators |
| `dr-race-facilitators` | Race management API routes |
| `dr-racers` | Racer-facing API routes |
| `dr-commentator` | Commentator/spectator access |
| `dr-registration` | Registration-desk access |

Users must be assigned to at least one group. Users with no group will be denied by the Identity Pool's `ambiguousRoleResolution: Deny` policy and will not receive AWS credentials.

### 2. Custom Attributes

The following mutable string attributes **must be defined** on the UserPool schema. Cognito does not allow adding attributes to an existing pool if they were not present at creation time.

| Attribute name | Type | Mutable |
|---|---|---|
| `custom:racerName` | String | Yes |
| `custom:countryCode` | String | Yes |

### 3. App Client

The App Client ID you supply via `externalUserPoolClientId` must:

- Have **no client secret** (browser-based SPA / public client)
- Allow at minimum the `USER_SRP_AUTH` auth flow
- **Not** have token revocation disabled (leave at Cognito default)
- Have token validity compatible with your session requirements (DRoA defaults: 1-day refresh token)

### 4. Trigger Lambdas

DRoA's owned-pool mode deploys three trigger Lambdas. When using an external pool you become responsible for equivalent behaviour. The table below describes what each trigger does and what breaks if it is missing.

| Trigger | Cognito event | What it does | Impact if missing |
|---|---|---|---|
| `preSignUp` | Before a new user is confirmed | Creates the user's profile record in DynamoDB; enforces username format and quota limits via AppConfig | New users will have no profile — most API calls will fail with a 404/403 until a profile is manually created |
| `postConfirmation` | After a user confirms their account | Adds the user to the `dr-racers` group | Users will not be in any group; Identity Pool role mapping will deny them AWS credentials |
| `preTokenGeneration` | On every token issuance | Injects DREM-compatible group aliases into the ID token (`dr-admins` → `admin`, `dr-race-facilitators` → `operator`, `dr-racers` → `racer`) | **Required only for DREM integration.** Without it, DREM's AppSync group-based authorisation will not recognise DRoA users. Standard DRoA operation is unaffected. |

The DRoA sample CDK project (`samples/external-userpool/`) deploys a ready-made UserPool with all three triggers pre-configured. You can use it as-is or adapt it.

#### Profile creation alternative (preSignUp)

If the external pool cannot attach a `preSignUp` trigger, DRoA can create a profile on first API call. This requires a code change to the API gateway middleware — raise a GitHub issue or open a PR if you need this path.

### 5. Sign-in Configuration

The external pool's sign-in aliases must include at minimum **email** and **username**. Users can log in with their email address or their Cognito account ID (internal username).

`signInCaseSensitive` should be `false` (Cognito default for new pools).

---

## What DRoA manages when using an external pool

Even with an external UserPool, DRoA continues to own and manage:

| Resource | Notes |
|---|---|
| **Cognito Identity Pool** | Always created by DRoA; trusts the external pool's provider |
| **IAM roles** (`AdminRole`, `RaceFacilitatorRole`, `RacerRole`) | Mapped from Cognito groups via Identity Pool rules |
| **EventBridge rules** for group/email changes | CloudTrail-based; reacts to `AdminAddUserToGroup` etc. on the external pool ID |
| **DynamoDB profile sync Lambdas** (`profileRoleChangeHandler`, `profileEmailChangeHandler`) | Keep DynamoDB in sync when an admin changes groups or email via the Cognito console or API |
| **API Gateway + all API Lambdas** | No change |
| **S3, CloudFront website** | No change |
| **IoT connectivity** | No change |

---

## What DRoA does NOT manage when using an external pool

| Resource | Your responsibility |
|---|---|
| UserPool creation, password policy, MFA | External pool owner |
| Cognito groups (creation) | External pool owner (must satisfy §1 above) |
| Custom attributes (schema) | External pool owner (must satisfy §2 above) |
| Trigger Lambdas | External pool owner (see §4 above) |
| Email delivery (SES / Cognito default) | External pool owner |
| Email invite templates | External pool owner |
| Initial admin user creation | External pool owner or manual Cognito console action |
| App Client configuration | External pool owner (must satisfy §3 above) |

---

## Diagram

```
External UserPool (customer-owned)
│
│  Required pre-configuration:
│  ├─ Groups: dr-admins, dr-race-facilitators, dr-racers,
│  │          dr-commentator, dr-registration
│  ├─ Custom attributes: custom:racerName, custom:countryCode
│  ├─ Trigger: preSignUp    → creates DynamoDB profile
│  ├─ Trigger: postConfirmation → assigns dr-racers group
│  └─ Trigger: preTokenGeneration → DREM group aliases (if DREM)
│
│  Issues JWT tokens (ID + Access token with cognito:groups claim)
│
▼
DRoA-owned Cognito Identity Pool
│  Trusts: external pool providerName + App Client ID
│  Role mapping: cognito:groups → AdminRole / FacilitatorRole / RacerRole
│
│  Issues: temporary IAM credentials (STS AssumeRoleWithWebIdentity)
│
▼
DRoA Application (API Gateway → Lambda → DynamoDB / S3 / IoT)
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Not authorized to access this resource" on every API call | User is not in any Cognito group — Identity Pool denies role assumption |
| 404 on profile-dependent API calls | `preSignUp` trigger did not run — DynamoDB profile was never created |
| DREM cannot see user roles | `preTokenGeneration` trigger is missing or not injecting group aliases |
| `UserNotFoundException` in logs | `externalUserPoolId` is wrong or the pool is in a different region |
| `InvalidParameterException: No identity found` | App Client ID does not match the pool, or has a client secret |
