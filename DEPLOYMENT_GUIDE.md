# Bunca Bakery Enhanced - Deployment Guide

## 🚀 Production Deployment

This guide covers deploying the enhanced Bunca Bakery system to production environments with full automation capabilities.

## Prerequisites

### System Requirements
- **Server**: Linux (Ubuntu 20.04+ recommended) or Windows Server
- **Memory**: Minimum 2GB RAM, 4GB+ recommended
- **Storage**: 20GB+ available space
- **Network**: Stable internet connection for updates

### Software Dependencies
- **Node.js**: Version 18.0 or higher
- **PostgreSQL**: Version 12.0 or higher
- **npm**: Version 8.0 or higher
- **Git**: For version control

## Step-by-Step Deployment

### 1. Server Preparation

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PostgreSQL
sudo apt install postgresql postgresql-contrib -y

# Install PM2 for process management
sudo npm install -g pm2

# Install Nginx for reverse proxy
sudo apt install nginx -y
```

### 2. Database Setup

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE bunca_bakery_prod;
CREATE USER bunca_admin WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE bunca_bakery_prod TO bunca_admin;
\q
```

### 3. Application Deployment

```bash
# Create application directory
sudo mkdir -p /opt/bunca-bakery
sudo chown $USER:$USER /opt/bunca-bakery

# Clone repository
cd /opt/bunca-bakery
git clone https://github.com/mouaz43/Bunca-Bakery-.git .

# Use enhanced configuration
cp package_enhanced.json package.json

# Install dependencies
npm install --production

# Create environment file
cp .env.example .env
```

### 4. Environment Configuration

Edit `/opt/bunca-bakery/.env`:

```env
# Database Configuration
DATABASE_URL=postgresql://bunca_admin:your_secure_password@localhost:5432/bunca_bakery_prod

# Security
SESSION_SECRET=your_very_secure_session_secret_here
ADMIN_EMAIL=admin@yourbakery.com
ADMIN_PASSWORD=$2b$10$hashed_password_here

# Application
NODE_ENV=production
PORT=3000

# Optional: Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password

# Optional: File Storage
UPLOAD_PATH=/opt/bunca-bakery/uploads
MAX_FILE_SIZE=10485760

# Optional: Redis for Caching
REDIS_URL=redis://localhost:6379
```

### 5. Security Hardening

```bash
# Create dedicated user
sudo useradd -r -s /bin/false bunca
sudo chown -R bunca:bunca /opt/bunca-bakery

# Set proper permissions
chmod 600 /opt/bunca-bakery/.env
chmod -R 755 /opt/bunca-bakery/public
chmod +x /opt/bunca-bakery/server_enhanced.js
```

### 6. Process Management with PM2

Create `/opt/bunca-bakery/ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'bunca-bakery',
    script: './server_enhanced.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/var/log/bunca-bakery/error.log',
    out_file: '/var/log/bunca-bakery/out.log',
    log_file: '/var/log/bunca-bakery/combined.log',
    time: true,
    max_memory_restart: '1G',
    node_args: '--max-old-space-size=1024'
  }]
};
```

```bash
# Create log directory
sudo mkdir -p /var/log/bunca-bakery
sudo chown bunca:bunca /var/log/bunca-bakery

# Start application
cd /opt/bunca-bakery
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save
pm2 startup
```

### 7. Nginx Reverse Proxy

Create `/etc/nginx/sites-available/bunca-bakery`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;
    
    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;
    
    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
    ssl_prefer_server_ciphers off;
    
    # Security Headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    
    # Gzip Compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/xml+rss application/json;
    
    # Rate Limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    location /api/login {
        limit_req zone=login burst=5 nodelay;
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # Static file caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        proxy_pass http://localhost:3000;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/bunca-bakery /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 8. SSL Certificate with Let's Encrypt

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx -y

# Obtain SSL certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

### 9. Database Initialization

```bash
# Run the enhanced server to create schema
cd /opt/bunca-bakery
NODE_ENV=production node server_enhanced.js

# The server will automatically create all tables and indexes
# Stop after schema creation (Ctrl+C)

# Start with PM2
pm2 restart bunca-bakery
```

### 10. Monitoring and Logging

```bash
# Install monitoring tools
sudo apt install htop iotop -y

# Set up log rotation
sudo tee /etc/logrotate.d/bunca-bakery << EOF
/var/log/bunca-bakery/*.log {
    daily
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 644 bunca bunca
    postrotate
        pm2 reloadLogs
    endscript
}
EOF

# Set up system monitoring
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
```

## Performance Optimization

### Database Optimization

```sql
-- Connect to database
psql -U bunca_admin -d bunca_bakery_prod

-- Analyze tables for query optimization
ANALYZE;

-- Create additional indexes for performance
CREATE INDEX CONCURRENTLY idx_production_plan_status_day ON production_plan(status, day);
CREATE INDEX CONCURRENTLY idx_inventory_transactions_date_type ON inventory_transactions(created_at, transaction_type);
CREATE INDEX CONCURRENTLY idx_materials_reorder ON materials(current_stock, reorder_point) WHERE active = true;

-- Set up automatic vacuum
ALTER SYSTEM SET autovacuum = on;
ALTER SYSTEM SET autovacuum_max_workers = 3;
SELECT pg_reload_conf();
```

### Application Caching

```bash
# Install Redis for caching
sudo apt install redis-server -y
sudo systemctl enable redis-server

# Configure Redis
sudo tee -a /etc/redis/redis.conf << EOF
maxmemory 256mb
maxmemory-policy allkeys-lru
EOF

sudo systemctl restart redis-server
```

### File System Optimization

```bash
# Create optimized directory structure
sudo mkdir -p /opt/bunca-bakery/{uploads,backups,logs,temp}
sudo chown -R bunca:bunca /opt/bunca-bakery/{uploads,backups,logs,temp}

# Set up automated backups
sudo tee /opt/bunca-bakery/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/bunca-bakery/backups"
DATE=$(date +%Y%m%d_%H%M%S)

# Database backup
pg_dump -U bunca_admin -h localhost bunca_bakery_prod | gzip > "$BACKUP_DIR/db_backup_$DATE.sql.gz"

# Application backup
tar -czf "$BACKUP_DIR/app_backup_$DATE.tar.gz" -C /opt/bunca-bakery --exclude=backups --exclude=node_modules .

# Keep only last 30 days of backups
find "$BACKUP_DIR" -name "*.gz" -mtime +30 -delete

echo "Backup completed: $DATE"
EOF

chmod +x /opt/bunca-bakery/backup.sh

# Schedule daily backups
sudo crontab -e
# Add: 0 2 * * * /opt/bunca-bakery/backup.sh >> /var/log/bunca-bakery/backup.log 2>&1
```

## Health Monitoring

### Application Health Checks

Create `/opt/bunca-bakery/health-check.sh`:

```bash
#!/bin/bash
HEALTH_URL="http://localhost:3000/healthz"
LOG_FILE="/var/log/bunca-bakery/health.log"

response=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL")

if [ "$response" = "200" ]; then
    echo "$(date): Health check passed" >> "$LOG_FILE"
else
    echo "$(date): Health check failed - HTTP $response" >> "$LOG_FILE"
    # Restart application if health check fails
    pm2 restart bunca-bakery
    
    # Send alert (configure email/SMS as needed)
    echo "Bunca Bakery health check failed at $(date)" | mail -s "Alert: Application Health Check Failed" admin@yourbakery.com
fi
```

```bash
chmod +x /opt/bunca-bakery/health-check.sh

# Run health check every 5 minutes
sudo crontab -e
# Add: */5 * * * * /opt/bunca-bakery/health-check.sh
```

### System Monitoring

```bash
# Install system monitoring
sudo apt install netdata -y

# Configure Netdata
sudo tee -a /etc/netdata/netdata.conf << EOF
[global]
    default port = 19999
    bind to = 127.0.0.1

[web]
    allow connections from = localhost 127.0.0.1
EOF

sudo systemctl restart netdata
```

## Security Checklist

- [ ] Database credentials are secure and unique
- [ ] Session secret is cryptographically strong
- [ ] Admin password is hashed with bcrypt
- [ ] SSL/TLS certificates are properly configured
- [ ] Firewall rules are configured (only ports 80, 443, 22 open)
- [ ] Regular security updates are scheduled
- [ ] Application runs as non-root user
- [ ] File permissions are properly set
- [ ] Rate limiting is configured
- [ ] Security headers are enabled
- [ ] Backup encryption is configured
- [ ] Audit logging is enabled

## Troubleshooting

### Common Issues

**Application won't start:**
```bash
# Check logs
pm2 logs bunca-bakery

# Check database connection
psql -U bunca_admin -d bunca_bakery_prod -c "SELECT NOW();"

# Check environment variables
pm2 env bunca-bakery
```

**Database connection errors:**
```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Check database exists
sudo -u postgres psql -l | grep bunca_bakery_prod

# Test connection
telnet localhost 5432
```

**Performance issues:**
```bash
# Check system resources
htop
iotop

# Check database performance
sudo -u postgres psql bunca_bakery_prod -c "SELECT * FROM pg_stat_activity;"

# Check application metrics
pm2 monit
```

### Emergency Procedures

**Application Recovery:**
```bash
# Stop application
pm2 stop bunca-bakery

# Restore from backup
cd /opt/bunca-bakery/backups
tar -xzf app_backup_YYYYMMDD_HHMMSS.tar.gz -C /opt/bunca-bakery-restore

# Restore database
gunzip -c db_backup_YYYYMMDD_HHMMSS.sql.gz | psql -U bunca_admin bunca_bakery_prod

# Restart application
pm2 start bunca-bakery
```

## Maintenance Schedule

### Daily
- Automated backups
- Health checks
- Log rotation

### Weekly
- Security updates
- Performance monitoring review
- Backup verification

### Monthly
- Full system update
- Database maintenance
- SSL certificate renewal check
- Security audit

### Quarterly
- Disaster recovery testing
- Performance optimization review
- Security penetration testing
- Documentation updates

## Support and Updates

### Getting Updates
```bash
cd /opt/bunca-bakery
git fetch origin
git checkout main
git pull origin main

# Update dependencies
npm install --production

# Restart application
pm2 restart bunca-bakery
```

### Support Channels
- GitHub Issues: Technical problems and bug reports
- Documentation: Comprehensive guides and API reference
- Community Forum: User discussions and best practices
- Professional Support: Enterprise support options available

---

**Congratulations!** Your Bunca Bakery Enhanced system is now deployed and ready for production use with full automation capabilities.
