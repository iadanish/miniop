import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucketName = process.env.R2_BUCKET_NAME

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error('R2 environment variables are not configured.')
  }

  return { accountId, accessKeyId, secretAccessKey, bucketName }
}

function createR2Client() {
  const { accountId, accessKeyId, secretAccessKey } = getR2Config()

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  })
}

export async function uploadObjectToR2(params: {
  key: string
  body: Buffer
  contentType: string
}) {
  const { bucketName } = getR2Config()
  const client = createR2Client()

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    }),
  )
}

export async function deleteObjectFromR2(key: string) {
  const { bucketName } = getR2Config()
  const client = createR2Client()

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    }),
  )
}