# Security Key Rotation Guide

## ⚠️ URGENT: Supabase Keys Exposed in Git History

**Date:** May 2026  
**Severity:** HIGH  
**Affected:** Previous commits contain `.env` with real Supabase keys  

---

## Exposed Credentials

The following keys were committed to git history and **must be rotated immediately**:

```
VITE_SUPABASE_PROJECT_ID="rwmgzazbuwwfnofltypq"
VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3bWd6YXpidXd3Zm5vZmx0eXBxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5MzcxNDgsImV4cCI6MjA4NTUxMzE0OH0._ivdqyzcNSLiR5J3eNriPD93xfwmfb8qeeDQ7K4DceI"
VITE_SUPABASE_URL="https://rwmgzazbuwwfnofltypq.supabase.co"
```

---

## Step-by-Step Rotation Process

### 1. Access Supabase Dashboard

1. Go to: https://app.supabase.com/
2. Log in with project owner account
3. Select project: `rwmgzazbuwwfnofltypq`

### 2. Rotate Anonymous Key (Publishable Key)

1. Navigate to **Project Settings** → **API**
2. Under **Project API Keys**, find **anon public**
3. Click **Generate new key**
4. Confirm rotation (this will invalidate the old key)
5. Copy the new `anon public` key

### 3. Update Environment Files

**⚠️ NEVER commit `.env` files**

Create/Update local `.env`:

```bash
# .env (this file is now in .gitignore - DO NOT COMMIT)
VITE_SUPABASE_PROJECT_ID="rwmgzazbuwwfnofltypq"
VITE_SUPABASE_PUBLISHABLE_KEY="<NEW_KEY_HERE>"
VITE_SUPABASE_URL="https://rwmgzazbuwwfnofltypq.supabase.co"
```

### 4. Update .env.example (Template)

The `.env.example` file should remain in git as a template:

```bash
# .env.example (this IS committed - no real values)
VITE_SUPABASE_PROJECT_ID="your-project-id"
VITE_SUPABASE_PUBLISHABLE_KEY="your-anon-key"
VITE_SUPABASE_URL="https://your-project-id.supabase.co"
```

### 5. Deploy with New Keys

```bash
# 1. Pull latest
npm install

# 2. Ensure .env has NEW keys
# Verify: cat .env | grep PUBLISHABLE_KEY

# 3. Build
npm run build

# 4. Deploy to production
# (Deployment method depends on your hosting platform)
```

### 6. Verify Rotation

```bash
# Build should complete successfully
npm run build

# Check that app connects to Supabase
# Look for successful auth/API calls in browser devtools
```

---

## What Was Done in Code

### ✅ Implemented Security Measures

1. **`.gitignore` updated:**
   ```
   .env
   .env.local
   .env.*.local
   ```

2. **`.env.example` created:**
   - Template with placeholder values
   - Documented in repository

3. **Security check script added:**
   ```bash
   npm run security:check-env
   ```

---

## Risk Assessment

| Risk | Level | Impact | Mitigation |
|------|-------|--------|------------|
| Unauthorized DB access | HIGH | Data breach | Rotate keys NOW |
| Data exfiltration | HIGH | HIPAA/GDPR violation | Rotate keys NOW |
| Injection attacks | MEDIUM | Data corruption | Row Level Security enabled |
| Replay attacks | LOW | Session hijacking | JWT tokens short-lived |

---

## Post-Rotation Checklist

- [ ] Keys rotated in Supabase dashboard
- [ ] New keys tested locally
- [ ] Production deployment updated
- [ ] Team notified of new key distribution method
- [ ] CI/CD secrets updated (if applicable)
- [ ] Old keys confirmed inactive (test API call with old key - should fail)

---

## Future Prevention

### ✅ Implemented
- `.env` in `.gitignore`
- `.env.example` template
- `npm run security:check-env` script

### 📋 Team Practices
1. **Never** commit `.env` files
2. Use `git status` before every commit
3. Run `npm run security:check-env` in pre-commit hook
4. Share keys via secure password manager (1Password, Bitwarden)
5. Rotate keys quarterly

---

## Audit Trail

| Date | Action | Status |
|------|--------|--------|
| 2026-05-02 | `.env` added to `.gitignore` | ✅ Complete |
| 2026-05-02 | `.env.example` created | ✅ Complete |
| 2026-05-02 | Security check script added | ✅ Complete |
| PENDING | Key rotation in Supabase | ⚠️ **URGENT** |
| PENDING | Production redeploy | ⚠️ **URGENT** |

---

## Emergency Contacts

If keys were exploited:

1. **Supabase Support:** support@supabase.com
2. **Project Admin:** [Your contact]
3. **Security Team:** [Your security contact]

---

**This is a security-critical task. Complete key rotation within 24 hours.**
