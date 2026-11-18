#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-2}"
BUCKET="${S3_BUCKET:-agentic-artifacts}"
QUEUE="${SQS_QUEUE_NAME:-agentic-tasks}"
DLQ="${SQS_DLQ_NAME:-agentic-tasks-dlq}"

echo "[init-aws] Creando bucket S3: ${BUCKET}"
awslocal s3api create-bucket \
  --bucket "${BUCKET}" \
  --region "${REGION}" \
  --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null 2>&1 || true

awslocal s3api put-bucket-versioning \
  --bucket "${BUCKET}" \
  --versioning-configuration Status=Enabled

awslocal s3api put-public-access-block \
  --bucket "${BUCKET}" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo "[init-aws] Creando colas SQS: ${DLQ} y ${QUEUE}"
awslocal sqs create-queue --queue-name "${DLQ}" --region "${REGION}" >/dev/null

DLQ_URL="$(awslocal sqs get-queue-url --queue-name "${DLQ}" --region "${REGION}" --query QueueUrl --output text)"
DLQ_ARN="$(awslocal sqs get-queue-attributes --queue-url "${DLQ_URL}" --attribute-names QueueArn --region "${REGION}" --query Attributes.QueueArn --output text)"

awslocal sqs create-queue \
  --queue-name "${QUEUE}" \
  --region "${REGION}" \
  --attributes "{\"VisibilityTimeout\":\"60\",\"MessageRetentionPeriod\":\"345600\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

echo "[init-aws] Recursos listos."
awslocal s3 ls
awslocal sqs list-queues --region "${REGION}"
