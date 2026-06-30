const path = require('path')
const { config: loadEnv } = require('dotenv')

const parentEnv =
  loadEnv({ path: path.resolve(__dirname, '../.env') }).parsed ?? {}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  images: {
    domains: ['localhost'],
  },
  env: {
    R2_ACCOUNT_ID: parentEnv.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: parentEnv.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: parentEnv.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: parentEnv.R2_BUCKET_NAME,
    SUPABASE_SERVICE_ROLE_KEY: parentEnv.SUPABASE_STAGING_SERVICE_KEY,
  },
}

module.exports = nextConfig
