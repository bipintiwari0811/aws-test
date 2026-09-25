#!/usr/bin/env bash
# Reads CloudFormation outputs and sets them as GitHub Actions variables.
# Requires: aws CLI, gh CLI (gh auth login), run from inside the repo folder.
set -euo pipefail

REGION="${AWS_REGION:?export AWS_REGION first}"
BASE_STACK="${BASE_STACK:-app3-base}"
OIDC_STACK="${OIDC_STACK:-github-oidc-app3}"

out() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

set_var() { echo "  $1 = $2"; gh variable set "$1" --body "$2"; }

echo "Setting GitHub variables:"
set_var AWS_REGION             "$REGION"
set_var AWS_DEPLOY_ROLE_ARN    "$(out "$OIDC_STACK" GitHubDeployRoleArn)"
set_var CFN_EXECUTION_ROLE_ARN "$(out "$OIDC_STACK" CfnExecutionRoleArn)"
set_var ECS_CLUSTER_NAME       "$(out "$BASE_STACK" ClusterName)"
set_var VPC_ID                 "$(out "$BASE_STACK" VpcId)"
set_var PRIVATE_SUBNETS        "$(out "$BASE_STACK" TaskSubnets)"
set_var ASSIGN_PUBLIC_IP       "$(out "$BASE_STACK" AssignPublicIp)"
set_var ALB_LISTENER_ARN       "$(out "$BASE_STACK" AlbListenerArn)"
set_var ALB_SG_ID              "$(out "$BASE_STACK" AlbSecurityGroupId)"
echo "Done. ALB URL: http://$(out "$BASE_STACK" AlbDnsName)/app3"
