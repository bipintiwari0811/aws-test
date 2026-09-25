# app3 — Node.js on ECS Fargate with Secrets Manager

A Node.js (Express) service deployed to an existing ECS Fargate cluster behind a shared ALB (path `/app3`),
built and deployed by GitHub Actions. The DB password lives only in AWS Secrets Manager and is injected
into the container by ECS at task start — it never appears in GitHub, the image, or the template.

## Structure

```
.github/workflows/deploy-app3.yml   CI/CD: test -> validate -> build/push -> deploy
app3/
  src/app.js                        Express app (routes)
  src/config.js                     Env-var config (DB_USER / DB_PASSWORD from Secrets Manager)
  src/server.js                     Entry point, startup checks, graceful shutdown
  test/                             Jest + Supertest tests
  Dockerfile
infra/
  base-network.yaml                 VPC, subnets, ALB (HTTP 80), ECS cluster (deploy once, manually)
  github-oidc-role.yaml             OIDC provider + deploy roles (deploy once, manually)
  app3-service.yaml                 Secret, IAM, task def, service, target group, listener rule, autoscaling
scripts/
  set-github-vars.sh                Copies stack outputs into GitHub Actions variables (needs gh CLI)
```

## Run locally

```bash
cd app3
npm install
npm test
DB_USER=local DB_PASSWORD=local BASE_PATH=/app3 npm start
curl http://localhost:3000/app3/health
```

## One-time AWS setup (fresh account)

```bash
export AWS_REGION=ap-south-1
export GH_USER=<github-user>
export GH_REPO=<repo-name>
```

1. **Base infra** — VPC, subnets, ALB, ECS cluster. `UseNatGateway=false` runs tasks in public subnets
   (cheapest for testing); `true` uses private subnets + NAT Gateway.

   ```bash
   aws cloudformation deploy --region $AWS_REGION --stack-name app3-base \
     --template-file infra/base-network.yaml --parameter-overrides UseNatGateway=false
   ```

2. **GitHub OIDC roles** — set `CreateOidcProvider=false` if `aws iam list-open-id-connect-providers`
   already shows `token.actions.githubusercontent.com`.

   ```bash
   aws cloudformation deploy --region $AWS_REGION --stack-name github-oidc-app3 \
     --template-file infra/github-oidc-role.yaml --capabilities CAPABILITY_IAM \
     --parameter-overrides GitHubOrg=$GH_USER GitHubRepo=$GH_REPO CreateOidcProvider=true
   ```

3. **ECR repo**

   ```bash
   aws ecr create-repository --region $AWS_REGION --repository-name app3 \
     --image-scanning-configuration scanOnPush=true
   ```

## GitHub setup

Run `./scripts/set-github-vars.sh` from the repo folder (requires `gh auth login`), or add these manually under
Settings → Secrets and variables → Actions → **Variables**:

| Variable | Source |
|---|---|
| `AWS_REGION` | your region |
| `AWS_DEPLOY_ROLE_ARN` | `github-oidc-app3` → `GitHubDeployRoleArn` |
| `CFN_EXECUTION_ROLE_ARN` | `github-oidc-app3` → `CfnExecutionRoleArn` |
| `ECS_CLUSTER_NAME` | `app3-base` → `ClusterName` |
| `VPC_ID` | `app3-base` → `VpcId` |
| `PRIVATE_SUBNETS` | `app3-base` → `TaskSubnets` |
| `ASSIGN_PUBLIC_IP` | `app3-base` → `AssignPublicIp` |
| `ALB_LISTENER_ARN` | `app3-base` → `AlbListenerArn` |
| `ALB_SG_ID` | `app3-base` → `AlbSecurityGroupId` |

Settings → Environments → create **production** (optionally add required reviewers).

Then Actions → **app3 CI/CD** → Run workflow.

## Verify

```bash
ALB=$(aws cloudformation describe-stacks --region $AWS_REGION --stack-name app3-base \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text)
curl http://$ALB/app3/health
curl http://$ALB/app3        # expect "secretLoaded": true
```

## Pipeline behaviour

- **Pull request to main:** runs tests + CloudFormation lint only.
- **Push to main:** tests → lint → build image tagged with commit SHA → push to ECR → `aws cloudformation deploy`.
  ECS rolls tasks; the deployment circuit breaker rolls back automatically if health checks fail.

## Secrets

- Created by the stack as `app3-service/app3/db` with a generated password (`DeletionPolicy: Retain`).
- To use an existing DB password:
  ```bash
  aws secretsmanager put-secret-value --secret-id app3-service/app3/db \
    --secret-string '{"username":"appuser","password":"<password>"}'
  aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment
  ```
- Secrets are read only at task start, so always force a new deployment after changing them.

## Endpoints

| Path | Description |
|---|---|
| `/app3/health` | ALB health check |
| `/app3` | App info (shows whether the secret loaded — never the value) |
| `/app3/hello/:name` | Sample route |

## Cleanup

```bash
aws cloudformation delete-stack --region $AWS_REGION --stack-name app3-service
aws cloudformation wait stack-delete-complete --region $AWS_REGION --stack-name app3-service
aws cloudformation delete-stack --region $AWS_REGION --stack-name app3-base
aws cloudformation delete-stack --region $AWS_REGION --stack-name github-oidc-app3
aws ecr delete-repository --region $AWS_REGION --repository-name app3 --force
aws secretsmanager delete-secret --region $AWS_REGION --secret-id app3-service/app3/db --force-delete-without-recovery
```
