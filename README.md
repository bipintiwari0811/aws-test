# app3 — Node.js on ECS Fargate with Secrets Manager (GitHub Actions)

A Node.js (Express) service on ECS Fargate behind an ALB (path `/app3`), built and deployed by GitHub Actions.
The DB password lives only in AWS Secrets Manager and is injected into the container by ECS at task start —
it never appears in GitHub, the image, or the template. GitHub authenticates to AWS with OIDC (no access keys).

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
  base-network.yaml                 VPC, subnets, ALB (HTTP 80), ECS cluster      (deploy once from laptop)
  github-oidc-role.yaml             GitHub OIDC provider + deploy roles           (deploy once from laptop)
  app3-service.yaml                 Secret, IAM, task def, service, ALB rule, autoscaling (deployed by pipeline)
scripts/
  set-github-vars.sh                Sets the GitHub Actions variables from stack outputs (needs gh CLI)
```

## Run locally

```bash
cd app3
npm install
npm test
DB_USER=local DB_PASSWORD=local BASE_PATH=/app3 npm start
curl http://localhost:3000/app3/health
```

## 1. Connect AWS CLI on your laptop

Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

Create an IAM user with an access key (IAM → Users → Create user → attach `AdministratorAccess` for this test →
Security credentials → Create access key → "Command Line Interface"). Do not use root account keys.

```bash
aws configure --profile app3
# Access key / Secret key / region (e.g. ap-south-1) / output: json

export AWS_PROFILE=app3
export AWS_REGION=ap-south-1
aws sts get-caller-identity
```

## 2. Deploy base infra and OIDC roles (from the repo folder)

```bash
aws cloudformation deploy --stack-name app3-base \
  --template-file infra/base-network.yaml --parameter-overrides UseNatGateway=false

# CreateOidcProvider=false if `aws iam list-open-id-connect-providers` already shows token.actions.githubusercontent.com
aws cloudformation deploy --stack-name github-oidc-app3 \
  --template-file infra/github-oidc-role.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides GitHubOrg=<github-user> GitHubRepo=<repo-name> CreateOidcProvider=true

aws ecr create-repository --repository-name app3 --image-scanning-configuration scanOnPush=true
```

## 3. GitHub variables

Run `./scripts/set-github-vars.sh` from the repo folder (requires `gh auth login`), or add these manually in
GitHub → Settings → Secrets and variables → Actions → **Variables** tab:

`AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `CFN_EXECUTION_ROLE_ARN`, `ECS_CLUSTER_NAME`, `VPC_ID`,
`PRIVATE_SUBNETS` (= `TaskSubnets` output), `ASSIGN_PUBLIC_IP`, `ALB_LISTENER_ARN`, `ALB_SG_ID`

Settings → Environments → create **production**. Then Actions → **app3 CI/CD** → Run workflow.

## Pipeline behaviour

- **Pull request:** test + CloudFormation lint only.
- **Push to main:** test → lint → build image tagged with commit SHA → push to ECR → `aws cloudformation deploy`.
  The ECS deployment circuit breaker rolls back automatically if health checks fail.

## Verify

```bash
ALB=$(aws cloudformation describe-stacks --stack-name app3-base \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text)
curl http://$ALB/app3/health
curl http://$ALB/app3        # expect "secretLoaded": true
```

## Secrets

- Created by the stack as `app3-service/app3/db` with a generated password (`DeletionPolicy: Retain`).
- Change it, then restart tasks (secrets are read only at task start):
  ```bash
  aws secretsmanager put-secret-value --secret-id app3-service/app3/db \
    --secret-string '{"username":"appuser","password":"<password>"}'
  aws ecs update-service --cluster app3-test-cluster \
    --service $(aws ecs list-services --cluster app3-test-cluster --query 'serviceArns[0]' --output text) \
    --force-new-deployment
  ```

## Cleanup

```bash
aws cloudformation delete-stack --stack-name app3-service
aws cloudformation wait stack-delete-complete --stack-name app3-service
aws cloudformation delete-stack --stack-name app3-base
aws cloudformation delete-stack --stack-name github-oidc-app3
aws ecr delete-repository --repository-name app3 --force
aws secretsmanager delete-secret --secret-id app3-service/app3/db --force-delete-without-recovery
```
Also delete the IAM user's access key when you're done testing.
