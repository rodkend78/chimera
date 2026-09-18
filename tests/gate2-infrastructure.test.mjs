import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const template = JSON.parse(await readFile(new URL('../infra/chimera-pilot-gate2.json', import.meta.url), 'utf8'))
const resources = template.Resources
const artifactTemplate = JSON.parse(await readFile(new URL('../infra/chimera-pilot-artifacts.json', import.meta.url), 'utf8'))

test('Gate 2 defaults every deployment to the approved USD 50 pilot ceiling', () => {
  assert.equal(template.Parameters.CostCeilingTag.Default, 'USD50-monthly-pilot')
})

function policyActions(role) {
  return role.Properties.Policies.flatMap((policy) => policy.PolicyDocument.Statement)
    .flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action])
}

test('Gate 2 audit table uses conditional-write-ready keys, KMS, recovery, and deletion protection', () => {
  const table = resources.AuditTable
  assert.equal(table.Type, 'AWS::DynamoDB::Table')
  assert.equal(table.DeletionPolicy, 'Retain')
  assert.equal(table.UpdateReplacePolicy, 'Retain')
  assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST')
  assert.equal(table.Properties.DeletionProtectionEnabled, true)
  assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true)
  assert.equal(table.Properties.SSESpecification.SSEEnabled, true)
  assert.equal(table.Properties.SSESpecification.SSEType, 'KMS')
  assert.deepEqual(table.Properties.KeySchema, [
    { AttributeName: 'streamId', KeyType: 'HASH' },
    { AttributeName: 'recordId', KeyType: 'RANGE' },
  ])
})

test('Gate 2 anchor bucket is retained, versioned, KMS encrypted, immutable, and private', () => {
  const bucket = resources.AuditAnchorBucket
  assert.equal(bucket.DeletionPolicy, 'Retain')
  assert.equal(bucket.UpdateReplacePolicy, 'Retain')
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled')
  assert.equal(bucket.Properties.ObjectLockEnabled, true)
  assert.equal(bucket.Properties.ObjectLockConfiguration.ObjectLockEnabled, 'Enabled')
  assert.equal(bucket.Properties.ObjectLockConfiguration.Rule.DefaultRetention.Mode, 'COMPLIANCE')
  assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicAcls, true)
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'aws:kms')
})

test('Gate 2 separates general runtime authority from Nostr secret retrieval', () => {
  const runtimeActions = policyActions(resources.PilotRuntimeRole)
  const brokerActions = policyActions(resources.SigningBrokerRole)
  const auditWriterActions = policyActions(resources.AuditWriterRole)
  const anchorWriterActions = policyActions(resources.AuditAnchorWriterRole)

  assert.equal(runtimeActions.includes('secretsmanager:GetSecretValue'), false)
  assert.equal(runtimeActions.includes('kms:Decrypt'), false)
  assert.equal(runtimeActions.includes('dynamodb:TransactWriteItems'), false)
  assert.equal(runtimeActions.includes('dynamodb:GetItem'), false)
  assert.equal(runtimeActions.includes('s3:PutObject'), false)
  assert.equal(runtimeActions.includes('kms:GenerateDataKey'), false)
  assert.equal(brokerActions.includes('secretsmanager:GetSecretValue'), true)
  assert.equal(brokerActions.includes('kms:Decrypt'), true)
  assert.equal(brokerActions.includes('dynamodb:TransactWriteItems'), false)
  assert.equal(auditWriterActions.includes('dynamodb:TransactWriteItems'), true)
  assert.equal(auditWriterActions.includes('dynamodb:PutItem'), true)
  assert.equal(auditWriterActions.includes('dynamodb:UpdateItem'), true)
  assert.equal(auditWriterActions.includes('dynamodb:DeleteItem'), false)
  assert.equal(auditWriterActions.includes('kms:Decrypt'), true)
  assert.equal(auditWriterActions.includes('kms:GenerateDataKey'), true)
  assert.equal(auditWriterActions.includes('secretsmanager:GetSecretValue'), false)
  assert.equal(anchorWriterActions.includes('s3:PutObject'), true)
  assert.equal(anchorWriterActions.includes('s3:DeleteObject'), false)
  assert.equal(anchorWriterActions.includes('kms:GenerateDataKey'), true)
  assert.equal(policyActions(resources.PilotRuntimeRole).some((action) => String(action).includes('*')), false)
  assert.equal(policyActions(resources.SigningBrokerRole).some((action) => String(action).includes('*')), false)
  assert.equal(policyActions(resources.AuditWriterRole).some((action) => String(action).includes('*')), false)
  assert.equal(policyActions(resources.AuditAnchorWriterRole).some((action) => String(action).includes('*')), false)
})

test('Gate 2 secret uses the customer-managed KMS key without embedding private material', () => {
  const secret = resources.NostrSigningSecret
  assert.equal(secret.Type, 'AWS::SecretsManager::Secret')
  assert.deepEqual(secret.Properties.KmsKeyId, { Ref: 'PilotKmsKey' })
  assert.equal('SecretString' in secret.Properties, false)
  assert.equal('GenerateSecretString' in secret.Properties, false)
})

test('Gate 2 artifacts bucket is private, encrypted, versioned, and expires old bundles', () => {
  const bucket = artifactTemplate.Resources.ArtifactBucket
  assert.equal(bucket.Type, 'AWS::S3::Bucket')
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled')
  assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicAcls, true)
  assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true)
  assert.equal(bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256')
  assert.equal(bucket.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays, 30)
})

test('Gate 2 audit writer is private and invokable without granting runtime Dynamo writes', () => {
  const writer = resources.AuditWriterFunction
  assert.equal(writer.Type, 'AWS::Lambda::Function')
  assert.equal(writer.Properties.Handler, 'index.handler')
  assert.equal(writer.Properties.Runtime, 'nodejs22.x')
  assert.equal('ReservedConcurrentExecutions' in writer.Properties, false)
  assert.deepEqual(writer.Properties.Environment.Variables.CHIMERA_AUDIT_TABLE, { Ref: 'AuditTable' })
  assert.deepEqual(writer.Properties.Role, { 'Fn::GetAtt': ['AuditWriterRole', 'Arn'] })
  assert.equal(Object.values(resources).some((resource) => resource.Type === 'AWS::Lambda::Url'), false)

  const runtimeStatements = resources.PilotRuntimeRole.Properties.Policies
    .flatMap((policy) => policy.PolicyDocument.Statement)
  const invoke = runtimeStatements.find((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    return actions.includes('lambda:InvokeFunction')
  })
  assert.deepEqual(invoke.Resource, { 'Fn::GetAtt': ['AuditWriterFunction', 'Arn'] })
  assert.equal(policyActions(resources.PilotRuntimeRole).includes('dynamodb:TransactWriteItems'), false)
})

test('Gate 2 anchor writer verifies Dynamo state and is the only scheduled immutable bucket writer', () => {
  const writer = resources.AuditAnchorWriterFunction
  assert.equal(writer.Type, 'AWS::Lambda::Function')
  assert.equal(writer.Properties.Handler, 'index.handler')
  assert.equal(writer.Properties.Runtime, 'nodejs22.x')
  assert.deepEqual(writer.Properties.Role, { 'Fn::GetAtt': ['AuditAnchorWriterRole', 'Arn'] })
  assert.deepEqual(writer.Properties.Environment.Variables.CHIMERA_AUDIT_TABLE, { Ref: 'AuditTable' })
  assert.deepEqual(writer.Properties.Environment.Variables.CHIMERA_AUDIT_ANCHOR_BUCKET, { Ref: 'AuditAnchorBucket' })

  const actions = policyActions(resources.AuditAnchorWriterRole)
  assert.equal(actions.includes('dynamodb:GetItem'), true)
  assert.equal(actions.includes('dynamodb:Query'), true)
  assert.equal(actions.includes('kms:Decrypt'), true)
  assert.equal(actions.includes('s3:PutObject'), true)
  assert.equal(actions.includes('s3:DeleteObject'), false)
  assert.equal(policyActions(resources.PilotRuntimeRole).includes('s3:PutObject'), false)

  const schedule = resources.AuditAnchorSchedule
  assert.equal(schedule.Type, 'AWS::Events::Rule')
  assert.equal(schedule.Properties.State, 'ENABLED')
  assert.equal(schedule.Properties.ScheduleExpression, 'rate(15 minutes)')
  assert.deepEqual(schedule.Properties.Targets[0].Arn, { 'Fn::GetAtt': ['AuditAnchorWriterFunction', 'Arn'] })
  assert.deepEqual(resources.AllowScheduledAuditAnchor.Properties.SourceArn, { 'Fn::GetAtt': ['AuditAnchorSchedule', 'Arn'] })
  assert.equal(resources.AllowScheduledAuditAnchor.Properties.Principal, 'events.amazonaws.com')
})

test('Gate 2 signing broker consumes one-time receipts without exposing custody to the runtime', () => {
  const table = resources.SigningReceiptTable
  assert.equal(table.Type, 'AWS::DynamoDB::Table')
  assert.equal(table.DeletionPolicy, 'Retain')
  assert.equal(table.Properties.DeletionProtectionEnabled, true)
  assert.equal(table.Properties.TimeToLiveSpecification.AttributeName, 'expiresAtEpoch')
  assert.equal(table.Properties.TimeToLiveSpecification.Enabled, true)

  const broker = resources.SigningBrokerFunction
  assert.equal(broker.Type, 'AWS::Lambda::Function')
  assert.equal(broker.Properties.Handler, 'index.handler')
  assert.equal(broker.Properties.Runtime, 'nodejs22.x')
  assert.deepEqual(broker.Properties.Role, { 'Fn::GetAtt': ['SigningBrokerRole', 'Arn'] })
  assert.deepEqual(broker.Properties.Environment.Variables.CHIMERA_NOSTR_SECRET_ID, { Ref: 'NostrSigningSecret' })
  assert.deepEqual(broker.Properties.Environment.Variables.CHIMERA_SIGNING_RECEIPT_TABLE, { Ref: 'SigningReceiptTable' })

  const brokerActions = policyActions(resources.SigningBrokerRole)
  assert.equal(brokerActions.includes('secretsmanager:GetSecretValue'), true)
  assert.equal(brokerActions.includes('kms:Decrypt'), true)
  assert.equal(brokerActions.includes('dynamodb:PutItem'), true)
  assert.equal(brokerActions.includes('dynamodb:GetItem'), false)
  assert.equal(brokerActions.includes('dynamodb:DeleteItem'), false)

  const runtimeStatements = resources.PilotRuntimeRole.Properties.Policies
    .flatMap((policy) => policy.PolicyDocument.Statement)
  const invokeBroker = runtimeStatements.find((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    return actions.includes('lambda:InvokeFunction')
      && JSON.stringify(statement.Resource).includes('SigningBrokerFunction')
  })
  assert.deepEqual(invokeBroker.Resource, { 'Fn::GetAtt': ['SigningBrokerFunction', 'Arn'] })
  assert.equal(policyActions(resources.PilotRuntimeRole).includes('secretsmanager:GetSecretValue'), false)
  assert.equal(policyActions(resources.PilotRuntimeRole).includes('kms:Decrypt'), false)
})
