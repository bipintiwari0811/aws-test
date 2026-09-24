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
  github-oidc-role.yaml             OIDC provider + deploy roles (deploy once, manually)
  app3-service.yaml                 Secret, IAM, task def, service, target group, listener rule, autoscaling
```

## Run locally

```bash
cd app3
npm install
npm test
DB_USER=local DB_PASSWORD=local BASE_PATH=/app3 npm start
curl http://localhost:3000/app3/health
```

## One-time AWS setup

1. Deploy the OIDC roles (set `CreateOidcProvider=false` if the GitHub OIDC provider already exists in the account):

   ```bash
   aws cloudformation deploy --stack-name github-oidc-app3 \
     --template-file infra/github-oidc-role.yaml \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides GitHubOrg=<github-user> GitHubRepo=<repo-name>
   ```

2. Create the ECR repo (if not already created):

   ```bash
   aws ecr create-repository --repository-name app3
   ```

## GitHub setup

Settings → Secrets and variables → Actions → **Variables**:

| Variable | Example |
|---|---|
| `AWS_REGION` | `ap-south-1` |
| `AWS_DEPLOY_ROLE_ARN` | output of `github-oidc-app3` stack |
| `CFN_EXECUTION_ROLE_ARN` | output of `github-oidc-app3` stack |
| `ECS_CLUSTER_NAME` | `my-java-app-cluster` |
| `VPC_ID` | `vpc-0123...` |
| `PRIVATE_SUBNETS` | `subnet-aaa,subnet-bbb` |
| `ALB_LISTENER_ARN` | `arn:aws:elasticloadbalancing:...:listener/app/...` |
| `ALB_SG_ID` | `sg-0123...` |

Settings → Environments → create **production** (optionally add required reviewers).

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
