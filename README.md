# app3 — Node.js on ECS Fargate with Secrets Manager (GitHub Actions)

A Node.js (Express) service on ECS Fargate behind an Application Load Balancer, deployed by GitHub Actions.
Credentials live only in **AWS Secrets Manager** and are injected into the container by ECS at task start —
they never appear in GitHub, the Docker image, or the CloudFormation template.
GitHub authenticates to AWS with **OIDC**, so no AWS access keys are stored in GitHub.

```
Internet ──► ALB (public subnets, HTTP 80, path /app3)
               │
               ▼
         ECS Fargate tasks (private subnets, no public IP)
               │  at start-up, via NAT Gateway:
               ├── pull image from ECR
               ├── read DB_USER / DB_PASSWORD / API_KEY from Secrets Manager
               └── send logs to CloudWatch
```

---

## Contents

1. [Project structure](#1-project-structure)
2. [Prerequisites](#2-prerequisites)
3. [Connect AWS CLI on your laptop](#3-connect-aws-cli-on-your-laptop)
4. [Deploy the AWS infrastructure](#4-deploy-the-aws-infrastructure)
5. [Configure GitHub](#5-configure-github)
6. [Run the pipeline and verify](#6-run-the-pipeline-and-verify)
7. [Day-to-day: deploying changes](#7-day-to-day-deploying-changes)
8. [Managing secrets](#8-managing-secrets)
9. [Task size and scaling](#9-task-size-and-scaling)
10. [Public vs private subnets](#10-public-vs-private-subnets)
11. [Troubleshooting](#11-troubleshooting)
12. [Cleanup](#12-cleanup)

---

## 1. Project structure

```
.github/workflows/deploy-app3.yml   CI/CD: test -> validate -> build/push -> deploy
app3/
  src/app.js                        Express routes (/app3, /app3/health, /app3/hello/:name)
  src/config.js                     The ONLY place that reads environment variables
  src/server.js                     Entry point, startup checks, graceful shutdown
  test/                             Jest + Supertest tests
  Dockerfile
  package.json, package-lock.json
infra/
  base-network.yaml                 VPC, subnets, NAT (optional), ALB, ECS cluster   -> deployed from laptop
  github-oidc-role.yaml             GitHub OIDC provider + deploy roles              -> deployed from laptop
  app3-service.yaml                 Secret, IAM roles, task def, service, ALB rule,  -> deployed by pipeline
                                    autoscaling
scripts/
  set-github-vars.sh                Copies stack outputs into GitHub Actions variables (needs gh CLI)
```

### Stacks created

| Stack | Deployed by | Contains |
|---|---|---|
| `app3-base` | laptop | VPC, 2 public + 2 private subnets, IGW, NAT Gateway (optional), ALB, ECS cluster |
| `github-oidc-app3` | laptop | GitHub OIDC provider, `GitHubDeployRole`, `CfnExecutionRole` |
| `app3-service` | pipeline | Secret `app3-service/app3/db`, execution/task roles, log group, task definition, service, target group, listener rule, autoscaling |

Plus an ECR repository `app3` created by CLI.

---

## 2. Prerequisites

- AWS account and an IAM user with an access key (for the laptop only)
- AWS CLI v2 — `aws --version`
- Git, and optionally the GitHub CLI (`gh`) for the variables script
- `jq` (used in a few commands)
- On Windows, run all commands in **Git Bash** or WSL

---

## 3. Connect AWS CLI on your laptop

Create an IAM user (IAM → Users → Create user, e.g. `app3-cli`, attach `AdministratorAccess` for testing)
and create an access key for **Command Line Interface**. Never use root account keys.

```bash
aws configure --profile app3
# Access key, Secret key, region: ap-south-1, output: json
```

Set these in **every new terminal** before running the commands in this README:

```bash
export AWS_PROFILE=app3
export AWS_REGION=ap-south-1
export GH_USER=<github-username>      # exactly as in github.com/<user>/<repo>
export GH_REPO=<repo-name>

aws sts get-caller-identity           # must show your account
```

---

## 4. Deploy the AWS infrastructure

Run from the repo root.

### 4.1 Base network, ALB and ECS cluster

```bash
# UseNatGateway=true  -> tasks in PRIVATE subnets behind a NAT Gateway (production-like, NAT billed hourly)
# UseNatGateway=false -> tasks in PUBLIC subnets with a public IP (cheapest for quick tests)
aws cloudformation deploy --stack-name app3-base \
  --template-file infra/base-network.yaml \
  --parameter-overrides UseNatGateway=true
```

### 4.2 GitHub OIDC roles

Repositories created after **15 July 2026** send an OIDC subject that includes the numeric owner and repo IDs
(`repo:user@123/repo@456:...`), so the template needs both IDs.

```bash
# Get the IDs (public repo). For a private repo use: gh api repos/$GH_USER/$GH_REPO --jq '{owner_id: .owner.id, repo_id: .id}'
curl -s https://api.github.com/repos/$GH_USER/$GH_REPO | jq '{owner_id: .owner.id, repo_id: .id}'

# If this already lists token.actions.githubusercontent.com, add CreateOidcProvider=false below
aws iam list-open-id-connect-providers

aws cloudformation deploy --stack-name github-oidc-app3 \
  --template-file infra/github-oidc-role.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GitHubOrg=$GH_USER GitHubRepo=$GH_REPO \
    GitHubOwnerId=<owner_id> GitHubRepoId=<repo_id>
```

### 4.3 ECR repository

```bash
aws ecr create-repository --repository-name app3 --image-scanning-configuration scanOnPush=true
```

---

## 5. Configure GitHub

### 5.1 Repository variables

Settings → **Secrets and variables → Actions → Variables tab** (not Secrets).
Values are the **actual** ARNs/IDs, not the output names.

Automatic (requires `gh auth login`):

```bash
./scripts/set-github-vars.sh
```

Or manually — print the values (text output avoids truncated ARNs):

```bash
aws cloudformation describe-stacks --stack-name app3-base \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
aws cloudformation describe-stacks --stack-name github-oidc-app3 \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
```

| GitHub variable | Take value from | Example |
|---|---|---|
| `AWS_REGION` | your region | `ap-south-1` |
| `AWS_DEPLOY_ROLE_ARN` | `github-oidc-app3` → `GitHubDeployRoleArn` | `arn:aws:iam::123456789012:role/github-oidc-app3-GitHubDeployRole-XXXX` |
| `CFN_EXECUTION_ROLE_ARN` | `github-oidc-app3` → `CfnExecutionRoleArn` | `arn:aws:iam::123456789012:role/github-oidc-app3-CfnExecutionRole-XXXX` |
| `ECS_CLUSTER_NAME` | `app3-base` → `ClusterName` | `app3-test-cluster` |
| `VPC_ID` | `app3-base` → `VpcId` | `vpc-0123...` |
| `PRIVATE_SUBNETS` | `app3-base` → `TaskSubnets` (**both** IDs) | `subnet-aaa,subnet-bbb` |
| `ASSIGN_PUBLIC_IP` | `app3-base` → `AssignPublicIp` | `DISABLED` (NAT) / `ENABLED` (no NAT) |
| `ALB_LISTENER_ARN` | `app3-base` → `AlbListenerArn` | `arn:aws:elasticloadbalancing:...:listener/app/...` |
| `ALB_SG_ID` | `app3-base` → `AlbSecurityGroupId` | `sg-0123...` |

`AlbDnsName` is not a variable — it is the URL you use to test the app.

### 5.2 Environment

Settings → **Environments → New environment** → name it `production` → Configure environment.
Optionally add yourself under *Required reviewers* to approve every deploy.

---

## 6. Run the pipeline and verify

Actions → **app3 CI/CD** → **Run workflow** (branch `main`). First deploy takes ~5–8 minutes.

```bash
ALB=$(aws cloudformation describe-stacks --stack-name app3-base \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text)

curl http://$ALB/app3/health        # {"status":"ok"}
curl http://$ALB/app3               # "dbUser":"appuser", "secretLoaded":true
```

`secretLoaded: true` confirms ECS injected the values from Secrets Manager.
In the console: EC2 → Target groups → `app3-...` should show 2 **Healthy** targets.

Check the tasks are private (NAT mode):

```bash
TASK=$(aws ecs list-tasks --cluster app3-test-cluster --query 'taskArns[0]' --output text)
ENI=$(aws ecs describe-tasks --cluster app3-test-cluster --tasks $TASK \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text)
aws ec2 describe-network-interfaces --network-interface-ids $ENI \
  --query 'NetworkInterfaces[0].{PrivateIP:PrivateIpAddress,PublicIP:Association.PublicIp}'
# PublicIP: null
```

---

## 7. Day-to-day: deploying changes

| You push to... | Changing... | Result |
|---|---|---|
| `main` | `app3/**`, `infra/app3-service.yaml`, or the workflow file | Test → Validate → **Build & Deploy** |
| `main` | only other files (e.g. README) | Nothing runs |
| a pull request into `main` | the paths above | Test + Validate only |
| any other branch | anything | Nothing runs |

Deploys are rolling (100% min healthy), with the ECS circuit breaker rolling back automatically if new tasks fail.
Images are tagged with the 7-character commit SHA.

Run locally:

```bash
cd app3
npm install
npm test
DB_USER=local DB_PASSWORD=local BASE_PATH=/app3 npm start
curl http://localhost:3000/app3/health
```

---

## 8. Managing secrets

### How it works

```
Secrets Manager key     infra/app3-service.yaml (Secrets:)        Node.js
  "password"     ──►   - Name: DB_PASSWORD                ──►  process.env.DB_PASSWORD
                         ValueFrom: <arn>:password::              (read only in src/config.js)
```

Two rules:
1. **ECS reads secrets only when a task starts** — after changing a value, force a new deployment.
2. **Every key referenced in `ValueFrom` must exist in the secret** — otherwise tasks fail to start.

### 8.1 Change an existing value (e.g. new password) — console only

1. Secrets Manager → `app3-service/app3/db` → **Retrieve secret value** → **Edit** → change value → **Save**.
2. ECS → Clusters → `app3-test-cluster` → Services → `app3-service-Service-...` → **Update service** →
   tick **Force new deployment** → **Update**.

CLI equivalent:

```bash
SECRET=app3-service/app3/db
CUR=$(aws secretsmanager get-secret-value --secret-id $SECRET --query SecretString --output text)
aws secretsmanager put-secret-value --secret-id $SECRET \
  --secret-string "$(echo "$CUR" | jq '.password = "NewStrongPass123"')"

aws ecs update-service --cluster app3-test-cluster \
  --service $(aws ecs list-services --cluster app3-test-cluster --query 'serviceArns[0]' --output text) \
  --force-new-deployment
```

`put-secret-value` replaces the whole JSON — always merge with `jq` as above, or use the console Key/value tab.

### 8.2 Add a new credential (e.g. `api_key`)

Order matters: **secret first, then code.**

1. Console: Secrets Manager → secret → Edit → **Add row** → `api_key` / value → Save.
2. `infra/app3-service.yaml`, under `Secrets:`:
   ```yaml
            - Name: API_KEY
              ValueFrom: !Sub '${AppSecret}:api_key::'
   ```
3. `app3/src/config.js`:
   ```js
       apiKey: env.API_KEY,
   ```
4. Use `config.apiKey` in your code, commit and push — the pipeline deploys it.

### 8.3 Add a separate secret

1. Create it: `aws secretsmanager create-secret --name app3/payment-api --secret-string '{"key":"..."}'`
2. Allow the execution role to read it (`ExecutionRole` → `Resource:`):
   ```yaml
                  - !Sub 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:app3/payment-api-*'
   ```
3. Map it: `ValueFrom: !Sub 'arn:aws:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:app3/payment-api:key::'`

### Do not

- Edit the `GenerateSecretString` block in the template (may regenerate the password).
- Put secrets in `Environment:`, GitHub variables, or logs.
- Add secret mappings by editing the task definition in the ECS console — the next pipeline run overwrites it.

Useful:

```bash
aws secretsmanager get-secret-value --secret-id $SECRET --query SecretString --output text | jq 'keys'
aws ecs describe-task-definition --task-definition app3-service-app3 \
  --query 'taskDefinition.containerDefinitions[0].secrets'
```

---

## 9. Task size and scaling

All in `infra/app3-service.yaml`:

```yaml
  TaskDefinition:
      Cpu: '256'          # 0.25 vCPU
      Memory: '512'       # 0.5 GB
  Service:
      DesiredCount: 2
  ScalableTarget:
      MinCapacity: 2
      MaxCapacity: 6
  CpuScaling:
        TargetValue: 60   # scale out above 60% average CPU
```

Valid Fargate CPU/memory pairs:

| Cpu | vCPU | Memory (MB) |
|---|---|---|
| 256 | 0.25 | 512, 1024, 2048 |
| 512 | 0.5 | 1024–4096 (1024 steps) |
| 1024 | 1 | 2048–8192 (1024 steps) |
| 2048 | 2 | 4096–16384 (1024 steps) |
| 4096 | 4 | 8192–30720 (1024 steps) |
| 8192 | 8 | 16384–61440 (4096 steps) |
| 16384 | 16 | 32768–122880 (8192 steps) |

Change, commit, push — ECS rolls out a new task definition revision with no downtime.

---

## 10. Public vs private subnets

| Mode | `UseNatGateway` | `PRIVATE_SUBNETS` var | `ASSIGN_PUBLIC_IP` var | Cost |
|---|---|---|---|---|
| Private (recommended) | `true` | private subnet IDs (`TaskSubnets`) | `DISABLED` | NAT billed hourly + per GB |
| Public (quick test) | `false` | public subnet IDs (`TaskSubnets`) | `ENABLED` | no NAT cost |

In both modes the ALB is public and the task security group only accepts traffic from the ALB.

To switch: redeploy `app3-base` with the new `UseNatGateway` value, copy the new `TaskSubnets` and
`AssignPublicIp` outputs into the two GitHub variables, then re-run the workflow.

The template creates **one** NAT Gateway (single AZ) to keep test costs low; for production use one per AZ.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Actions tab shows "Get started with GitHub Actions" | `.github/workflows/` not pushed (dot-folder skipped) | Check the Code tab; create the file via *set up a workflow yourself* or push it with git |
| `Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity` | Trust policy `sub` doesn't match the token | Check `GH_USER`/`GH_REPO` spelling and case; redeploy `github-oidc-app3` with `GitHubOwnerId` and `GitHubRepoId`; check `AWS_DEPLOY_ROLE_ARN` variable value |
| `ResourceInitializationError: unable to pull secrets ... connection issue ... Secrets Manager` | Tasks have no route out | `PRIVATE_SUBNETS` must equal `TaskSubnets` (both IDs); `ASSIGN_PUBLIC_IP` must match `AssignPublicIp`; NAT mode needs `UseNatGateway=true` |
| Stack `ROLLBACK_COMPLETE` | First create failed; stack can't be updated | Delete `app3-service` and the retained secret (see Cleanup step 1–2), then re-run |
| `app3-service/app3/db already exists` | Secret retained from a failed attempt | `aws secretsmanager delete-secret --secret-id app3-service/app3/db --force-delete-without-recovery` |
| `Priority '30' is currently in use` | Another listener rule uses 30 | Change `ListenerRulePriority` in the workflow |
| Targets unhealthy / tasks restarting | `/app3/health` failing | `aws logs tail /ecs/app3-service/app3 --follow` |
| `Cannot connect to the Docker daemon` | n/a on GitHub-hosted runners | Keep `runs-on: ubuntu-latest` |

Useful diagnostics:

```bash
aws cloudformation describe-stack-events --stack-name app3-service \
  --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason] | [0:5]" --output text

aws ecs describe-services --cluster app3-test-cluster \
  --services $(aws ecs list-services --cluster app3-test-cluster --query 'serviceArns[0]' --output text) \
  --query 'services[0].[runningCount,events[0:5].message]'

aws logs tail /ecs/app3-service/app3 --follow
```

---

## 12. Cleanup

Delete in this order (the service stack depends on the base stack):

```bash
export AWS_PROFILE=app3 AWS_REGION=ap-south-1

# 1. Service: ECS service, task def, target group, listener rule, roles, log group
aws cloudformation delete-stack --stack-name app3-service
aws cloudformation wait stack-delete-complete --stack-name app3-service

# 2. Secret (kept by DeletionPolicy: Retain)
aws secretsmanager delete-secret --secret-id app3-service/app3/db --force-delete-without-recovery

# 3. Container images
aws ecr delete-repository --repository-name app3 --force

# 4. Base: NAT Gateway, Elastic IP, ALB, ECS cluster, subnets, VPC
aws cloudformation delete-stack --stack-name app3-base
aws cloudformation wait stack-delete-complete --stack-name app3-base

# 5. GitHub OIDC roles (and provider, if this stack created it)
aws cloudformation delete-stack --stack-name github-oidc-app3
aws cloudformation wait stack-delete-complete --stack-name github-oidc-app3
```

Verify nothing billable is left:

```bash
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED \
  --query "StackSummaries[?contains(StackName,'app3')].[StackName,StackStatus]" --output table
aws ec2 describe-nat-gateways --filter Name=state,Values=available,pending --query 'NatGateways[].NatGatewayId'
aws ec2 describe-addresses --query 'Addresses[].[PublicIp,AllocationId]'
aws elbv2 describe-load-balancers --query "LoadBalancers[?contains(LoadBalancerName,'app3')].LoadBalancerName"
aws ecs list-clusters
aws secretsmanager list-secrets --query "SecretList[?contains(Name,'app3')].Name"
```

All of these should return empty lists.

Finally:
- IAM → Users → `app3-cli` → delete the access key (or delete the user).
- GitHub (optional): remove the Actions variables and the `production` environment, or disable the workflow
  (Actions → app3 CI/CD → ⋯ → Disable workflow) so a push doesn't fail against deleted resources.

To deploy again later, start from [section 3](#3-connect-aws-cli-on-your-laptop).
