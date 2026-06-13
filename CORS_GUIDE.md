# CORS 配置与测试指南

## 快速开始

### 运行单元测试
```bash
npm run test:cors
```

### 运行集成测试
```bash
# 1. 先启动服务
npm run dev

# 2. 在另一个终端运行测试
npm run test:cors:integration
```

## 配置说明

### 环境变量

#### ALLOWED_DOMAIN
- **类型**: string
- **默认值**: `"*"`
- **说明**: 允许的域名列表，多个域名用逗号分隔
- **示例**:
  ```env
  ALLOWED_DOMAIN="*"                          # 允许所有域名
  ALLOWED_DOMAIN="https://example.com"        # 只允许指定域名
  ALLOWED_DOMAIN="https://a.com,https://b.com" # 允许多个域名
  ```

#### ALLOWED_HOST
- **类型**: string
- **默认值**: `"imsyy.top"`
- **说明**: 允许的主域名，支持子域名匹配
- **注意**: 当 ALLOWED_DOMAIN 不为 `"*"` 时生效
- **示例**:
  ```env
  ALLOWED_HOST="example.com"  # 允许 example.com 和 *.example.com
  ```

### 配置优先级

1. **无 Origin 头**: 直接允许（curl、服务端调用等）
2. **ALLOWED_DOMAIN="*"**: 允许所有来源
3. **同源检查**: 允许同源请求
4. **ALLOWED_HOST**: 允许匹配的域名和子域名
5. **ALLOWED_DOMAIN 列表**: 允许列表中的域名
6. **其他**: 拒绝

### 常见配置场景

#### 场景 1: 开发环境（允许所有）
```env
ALLOWED_DOMAIN="*"
ALLOWED_HOST=""
```

#### 场景 2: 生产环境（严格限制）
```env
ALLOWED_DOMAIN=""
ALLOWED_HOST="yourdomain.com"
```

#### 场景 3: 多域名支持
```env
ALLOWED_DOMAIN="https://app.example.com,https://admin.example.com"
ALLOWED_HOST=""
```

#### 场景 4: 子域名通配
```env
ALLOWED_DOMAIN=""
ALLOWED_HOST="example.com"  # 允许 example.com 和所有子域名
```

## 测试用例

### 1. 无 Origin 头（curl/服务端调用）
```bash
curl http://localhost:6688/
```
**期望**: 200 OK，正常返回数据

### 2. 预检请求（OPTIONS）
```bash
curl -X OPTIONS \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  http://localhost:6688/
```
**期望**: 204 No Content，包含 CORS 响应头

### 3. 带 credentials 的请求
```bash
curl -H "Origin: https://example.com" \
     -H "Cookie: session=abc123" \
     http://localhost:6688/
```
**期望**: 200 OK，Access-Control-Allow-Credentials: true

### 4. 合法 Origin
```bash
curl -H "Origin: https://yourdomain.com" \
     http://localhost:6688/all
```
**期望**: 200 OK，Access-Control-Allow-Origin: https://yourdomain.com

### 5. 非法 Origin（当配置了严格限制）
```bash
curl -H "Origin: https://evil.com" \
     http://localhost:6688/all
```
**期望**: 403 Forbidden（仅在严格配置下）

## CORS 响应头

所有 CORS 响应都包含以下头：

```
Access-Control-Allow-Origin: <origin> 或 *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Custom-Header, Upgrade-Insecure-Requests
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

## 日志输出

### 调试模式
```
DEBUG ✓ [CORS] All origins allowed (ALLOWED_DOMAIN=*) | Origin: https://example.com
DEBUG ✓ [CORS] Preflight request allowed | Origin: https://example.com
```

### 警告模式
```
WARN  ✗ [CORS] Origin not allowed: https://evil.com | Method: GET
WARN  ⚠️  [CORS] Failed to parse origin: invalid-url
```

### 错误模式
```
ERROR ❌ [CORS] Request denied | Origin: https://evil.com | Path: /api/data | Method: GET
```

## 故障排查

### 问题 1: curl 请求失败
**原因**: 可能是 CORS 中间件错误
**解决**: 检查日志，确保无 Origin 头的请求被正确处理

### 问题 2: 预检请求（OPTIONS）失败
**原因**: OPTIONS 请求没有被正确处理
**解决**: 确保 OPTIONS 请求返回 204 和正确的 CORS 头

### 问题 3: credentials 请求失败
**原因**: Access-Control-Allow-Origin 不能是 "*"
**解决**: 确保返回具体的 Origin 而不是 "*"

### 问题 4: 子域名不被允许
**原因**: ALLOWED_HOST 配置不正确
**解决**: 设置 ALLOWED_HOST 为主域名（如 example.com）

## 相关文件

- `src/utils/cors.ts` - CORS 验证逻辑
- `src/app.tsx` - CORS 中间件配置
- `src/__tests__/cors-unit.test.ts` - 单元测试
- `src/__tests__/cors.test.ts` - 集成测试
- `CORS_FIX_REPORT.md` - 修复报告
