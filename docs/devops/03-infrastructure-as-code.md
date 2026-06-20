# Infrastructure as Code

## Overview

MiniOp's infrastructure spans compute (VMs and Kubernetes), databases (PostgreSQL with pgvector), object storage (S3/MinIO), caching (Redis), GPU workloads (video processing), CDN (CloudFront), and DNS. This document covers provisioning with Terraform for both a free-tier single-VM setup and a production Kubernetes cluster on AWS. Every piece of infrastructure is defined in code — no manual console clicks.

---

## Project Structure

```
infra/
├── modules/
│   ├── networking/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── compute/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── database/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── storage/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── kubernetes/
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
├── environments/
│   ├── free-tier/
│   │   ├── main.tf
│   │   ├── terraform.tfvars
│   │   └── backend.tf
│   ├── staging/
│   │   ├── main.tf
│   │   ├── terraform.tfvars
│   │   └── backend.tf
│   └── production/
│       ├── main.tf
│       ├── terraform.tfvars
│       └── backend.tf
└── README.md
```

---

## Free Tier (Single VM on Hetzner/DigitalOcean)

The free-tier setup provisions a single VM running Docker Compose. Total cost: ~$5-10/month.

### Provider and Backend

`environments/free-tier/backend.tf`:

```hcl
terraform {
  backend "s3" {
    bucket         = "minio-terraform-state"
    key            = "free-tier/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}
```

`environments/free-tier/main.tf`:

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

module "networking" {
  source       = "../../modules/networking"
  environment  = "free-tier"
  network_cidr = "10.0.0.0/16"
  subnet_cidr  = "10.0.1.0/24"
}

module "compute" {
  source        = "../../modules/compute"
  environment   = "free-tier"
  server_type   = "cx31"  # 2 vCPU, 8GB RAM
  image         = "ubuntu-22.04"
  network_id    = module.networking.network_id
  ssh_key_ids   = [var.ssh_key_id]
  location      = "fsn1"
}
```

### Compute Module

`modules/compute/main.tf`:

```hcl
resource "hcloud_server" "minio" {
  name        = "minio-${var.environment}"
  server_type = var.server_type
  image       = var.image
  location    = var.location
  ssh_keys    = var.ssh_key_ids

  network {
    network_id = var.network_id
    ip         = "10.0.1.10"
  }

  user_data = templatefile("${path.module}/cloud-init.yml", {
    environment = var.environment
  })

  labels = {
    environment = var.environment
    managed_by  = "terraform"
    application = "minio"
  }

  lifecycle {
    ignore_changes = [user_data]
  }
}

resource "hcloud_firewall" "minio" {
  name = "minio-${var.environment}"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.admin_ip]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server_network" "minio" {
  server_id = hcloud_server.minio.id
  subnet_id = var.subnet_id
}
```

### Cloud-Init Provisioning

`modules/compute/cloud-init.yml`:

```yaml
#cloud-config
package_update: true
package_upgrade: true

packages:
  - docker.io
  - docker-compose-plugin
  - nginx
  - certbot
  - python3-certbot-nginx
  - fail2ban

users:
  - name: deploy
    groups: docker
    shell: /bin/bash
    ssh_authorized_keys:
      - ${ssh_public_key}

write_files:
  - path: /opt/minio/docker-compose.yml
    content: |
      version: "3.9"
      services:
        postgres:
          image: pgvector/pgvector:pg16
          restart: unless-stopped
          environment:
            POSTGRES_USER: minio
            POSTGRES_PASSWORD: ${db_password}
            POSTGRES_DB: minio
          volumes:
            - pgdata:/var/lib/postgresql/data
          healthcheck:
            test: ["CMD-SHELL", "pg_isready -U minio"]
            interval: 10s
            timeout: 5s
            retries: 5

        redis:
          image: redis:7-alpine
          restart: unless-stopped
          command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
          volumes:
            - redisdata:/data

        minio-s3:
          image: minio/minio:latest
          restart: unless-stopped
          command: server /data --console-address ":9001"
          environment:
            MINIO_ROOT_USER: minioadmin
            MINIO_ROOT_PASSWORD: ${s3_password}
          volumes:
            - s3data:/data

        backend:
          image: ghcr.io/minio-project/backend:latest
          restart: unless-stopped
          environment:
            DATABASE_URL: postgresql://minio:${db_password}@postgres:5432/minio
            REDIS_URL: redis://redis:6379/0
            S3_ENDPOINT: http://minio-s3:9000
            S3_ACCESS_KEY: minioadmin
            S3_SECRET_KEY: ${s3_password}
          depends_on:
            postgres:
              condition: service_healthy

        frontend:
          image: ghcr.io/minio-project/frontend:latest
          restart: unless-stopped
          environment:
            NEXT_PUBLIC_API_URL: https://${domain}/api
          depends_on:
            - backend

      volumes:
        pgdata:
        redisdata:
        s3data:

  - path: /etc/nginx/sites-available/minio
    content: |
      server {
          listen 80;
          server_name ${domain};

          location / {
              proxy_pass http://localhost:3000;
              proxy_set_header Host $host;
              proxy_set_header X-Real-IP $remote_addr;
              proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
              proxy_set_header X-Forwarded-Proto $scheme;
          }

          location /api/ {
              proxy_pass http://localhost:8000/;
              proxy_set_header Host $host;
              proxy_set_header X-Real-IP $remote_addr;
              proxy_buffering off;
              client_max_body_size 500m;
          }

          location /api/ws/ {
              proxy_pass http://localhost:8000/ws/;
              proxy_http_version 1.1;
              proxy_set_header Upgrade $http_upgrade;
              proxy_set_header Connection "upgrade";
          }
      }

runcmd:
  - ln -sf /etc/nginx/sites-available/minio /etc/nginx/sites-enabled/
  - rm /etc/nginx/sites-enabled/default
  - systemctl enable nginx docker
  - systemctl start docker
  - ufw allow 22/tcp
  - ufw allow 80/tcp
  - ufw allow 443/tcp
  - ufw --force enable
```

Initialize and deploy:

```bash
cd infra/environments/free-tier
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

---

## Production (AWS EKS)

### Networking

`modules/networking/main.tf` (AWS):

```hcl
resource "aws_vpc" "main" {
  cidr_block           = var.network_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "minio-${var.environment}"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_subnet" "public" {
  count                   = 3
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.network_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                           = "minio-public-${count.index}"
    "kubernetes.io/role/elb"                       = "1"
    "kubernetes.io/cluster/minio-${var.environment}" = "shared"
  }
}

resource "aws_subnet" "private" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.network_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name                                             = "minio-private-${count.index}"
    "kubernetes.io/role/internal-elb"                = "1"
    "kubernetes.io/cluster/minio-${var.environment}"  = "shared"
  }
}

resource "aws_nat_gateway" "main" {
  count         = 3
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "minio-nat-${count.index}"
  }
}

resource "aws_route_table" "private" {
  count  = 3
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }
}
```

### EKS Cluster

`modules/kubernetes/main.tf`:

```hcl
resource "aws_eks_cluster" "minio" {
  name     = "minio-${var.environment}"
  role_arn = aws_iam_role.eks_cluster.arn
  version  = "1.29"

  vpc_config {
    subnet_ids              = concat(var.public_subnet_ids, var.private_subnet_ids)
    endpoint_private_access = true
    endpoint_public_access  = var.environment != "production"
    security_group_ids      = [aws_security_group.eks_cluster.id]
  }

  encryption_config {
    provider {
      key_arn = aws_kms_key.eks.arn
    }
    resources = ["secrets"]
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_policy,
    aws_iam_role_policy_attachment.eks_vpc_resource_controller,
  ]
}

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.minio.name
  node_group_name = "general"
  node_role_arn   = aws_iam_role.eks_node.arn
  subnet_ids      = var.private_subnet_ids

  instance_types = ["m6i.xlarge"]
  capacity_type  = "ON_DEMAND"

  scaling_config {
    desired_size = 3
    max_size     = 10
    min_size     = 2
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    role = "general"
  }
}

resource "aws_eks_node_group" "gpu" {
  cluster_name    = aws_eks_cluster.minio.name
  node_group_name = "gpu-workers"
  node_role_arn   = aws_iam_role.eks_node.arn
  subnet_ids      = var.private_subnet_ids

  instance_types = ["g4dn.xlarge"]  # 1x T4 GPU, 4 vCPU, 16GB RAM
  capacity_type  = "ON_DEMAND"

  scaling_config {
    desired_size = 1
    max_size     = 5
    min_size     = 0
  }

  taint {
    key    = "nvidia.com/gpu"
    value  = "present"
    effect = "NO_SCHEDULE"
  }

  labels = {
    accelerator = "nvidia-tesla-t4"
    role        = "gpu-worker"
  }
}
```

### RDS PostgreSQL

`modules/database/main.tf`:

```hcl
resource "aws_db_subnet_group" "minio" {
  name       = "minio-${var.environment}"
  subnet_ids = var.private_subnet_ids
}

resource "aws_rds_cluster" "minio" {
  cluster_identifier      = "minio-${var.environment}"
  engine                  = "aurora-postgresql"
  engine_version          = "15.4"
  database_name           = "minio"
  master_username         = "minio"
  master_password         = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.minio.name
  vpc_security_group_ids  = [var.db_security_group_id]
  backup_retention_period = 30
  preferred_backup_window = "03:00-04:00"
  storage_encrypted       = true
  deletion_protection     = var.environment == "production"

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 16
  }
}

resource "aws_rds_cluster_instance" "minio" {
  count              = var.environment == "production" ? 2 : 1
  identifier         = "minio-${var.environment}-${count.index}"
  cluster_identifier = aws_rds_cluster.minio.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.minio.engine
  engine_version     = aws_rds_cluster.minio.engine_version
}
```

### S3 for Video Storage

`modules/storage/main.tf`:

```hcl
resource "aws_s3_bucket" "videos" {
  bucket = "minio-videos-${var.environment}"

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  rule {
    id     = "archive-old-clips"
    status = "Enabled"

    filter {
      prefix = "clips/"
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365
    }
  }

  rule {
    id     = "cleanup-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    expiration {
      days = 7
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "videos" {
  bucket = aws_s3_bucket.videos.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST"]
    allowed_origins = ["https://${var.domain}"]
    max_age_seconds = 3600
  }
}

resource "aws_cloudfront_distribution" "videos" {
  origin {
    domain_name = aws_s3_bucket.videos.bucket_regional_domain_name
    origin_id   = "s3-videos"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.videos.cloudfront_access_identity_path
    }
  }

  enabled         = true
  is_ipv6_enabled = true
  comment         = "MinIO video CDN"

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "s3-videos"
    compress         = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 86400
    max_ttl                = 31536000
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
```

---

## Production Main Composition

`environments/production/main.tf`:

```hcl
module "networking" {
  source       = "../../modules/networking"
  environment  = "production"
  network_cidr = "10.0.0.0/16"
}

module "database" {
  source               = "../../modules/database"
  environment          = "production"
  private_subnet_ids   = module.networking.private_subnet_ids
  db_security_group_id = module.networking.db_security_group_id
  db_password          = var.db_password
}

module "storage" {
  source                = "../../modules/storage"
  environment           = "production"
  domain                = "minio.clip"
  acm_certificate_arn   = var.acm_certificate_arn
}

module "kubernetes" {
  source              = "../../modules/kubernetes"
  environment         = "production"
  vpc_id              = module.networking.vpc_id
  public_subnet_ids   = module.networking.public_subnet_ids
  private_subnet_ids  = module.networking.private_subnet_ids
}

output "eks_cluster_endpoint" {
  value = module.kubernetes.cluster_endpoint
}

output "database_endpoint" {
  value     = module.database.cluster_endpoint
  sensitive = true
}

output "cdn_domain" {
  value = module.storage.cloudfront_domain
}
```

---

## State Management and Locking

```hcl
# One-time bootstrap (run locally)
resource "aws_dynamodb_table" "terraform_locks" {
  name         = "terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = "minio-terraform-state"

  versioning {
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        sse_algorithm = "AES256"
      }
    }
  }
}
```

---

## Secrets in Terraform

Never commit secrets to `.tfvars`. Use one of these approaches:

```bash
# Option 1: Environment variables
export TF_VAR_db_password="$(aws ssm get-parameter --name /minio/production/db-password --with-decryption --query Parameter.Value --output text)"
terraform apply

# Option 2: Encrypted tfvars with SOPS
sops --encrypt --in-place environments/production/secrets.tfvars.json
terraform apply -var-file=secrets.tfvars.json

# Option 3: Terraform Cloud variables (if using TFC)
```

---

## CI Integration

```yaml
# .github/workflows/infra.yml
name: Infrastructure
on:
  pull_request:
    paths: ["infra/**"]
  push:
    branches: [main]
    paths: ["infra/**"]

jobs:
  plan:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/environments/production
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.7.0
      - run: terraform init -backend-config="key=production/terraform.tfstate"
      - run: terraform validate
      - run: terraform plan -out=tfplan
      - uses: actions/upload-artifact@v4
        with:
          name: tfplan
          path: infra/environments/production/tfplan

  apply:
    needs: plan
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - uses: actions/download-artifact@v4
        with:
          name: tfplan
          path: infra/environments/production
      - run: terraform init -backend-config="key=production/terraform.tfstate"
      - run: terraform apply tfplan
```

---

## Drift Detection

Run weekly drift detection to catch manual changes:

```bash
# Cron or scheduled CI job
terraform plan -detailed-exitcode
EXIT_CODE=$?
if [ $EXIT_CODE -eq 2 ]; then
  echo "DRIFT DETECTED — infrastructure differs from code"
  # Alert via Slack/PagerDuty
fi
```

---

## Summary

Free tier: one Terraform composition provisions a Hetzner VM with cloud-init that installs Docker Compose. Production: modular Terraform provisions VPC, EKS with GPU node groups, Aurora PostgreSQL Serverless v2, S3 with lifecycle policies, and CloudFront CDN. All state lives in S3 with DynamoDB locking. Secrets come from SSM or SOPS-encrypted files — never from version control.
