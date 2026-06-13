# CORS 修复测试报告

## 修复概述

修复了 `src/app.tsx` 中的 CORS 处理逻辑，解决了以下问题：
1. 无 Origin 头的请求（curl、服务端调用、健康检查）导致异常
2. 预检请求（OPTIONS）处理不当
3. 错误日志不够详细
4. 配置组合逻辑不清晰

## 修改内容

### 1. 新增 CORS 工具函数
- 文件：`src/utils/cors.ts`
- 功能：
  - `validateCorsOrigin()`: 验证 CORS 来源是否合法
  - `getCorsHeaders()`: 获取 CORS 响应头
  - 详细的日志记录

### 2. 修改主应用
- 文件：`src/app.tsx`
- 变更：
  - 替换 Hono 内置 cors 中间件为自定义实现
  - 正确处理预检请求（OPTIONS）
  - 添加详细的 CORS 验证日志
  - 支持多种配置组合

### 3. 添加测试
- 单元测试：`src/__tests__/cors-unit.test.ts`
- 集成测试：`src/__tests__/cors.test.ts`
- 测试脚本：`npm run test:cors` 和 `npm run test:cors:integration`

## 测试场景与结果

### 单元测试（9/9 通过）

1. ✓ 无 Origin 头应该允许
2. ✓ 空字符串 Origin 应该允许
3. ✓ 空白字符串 Origin 应该允许
4. ✓ ALLOWED_DOMAIN=* 时任意 Origin 应该允许
5. ✓ 同源请求应该允许
6. ✓ 完全匹配 ALLOWED_HOST 应该允许
7. ✓ 子域名匹配 ALLOWED_HOST 应该允许
8. ✓ 非法 Origin 应该拒绝
9. ✓ 无效的 Origin 格式应该拒绝

### 集成测试（HTTP 请求）

#### 测试 1: 无 Origin 头（curl 请求）
```
请求: curl http://localhost:6688/
状态: ✓ 200 OK
CORS: Access-Control-Allow-Origin: *
说明: curl、服务端调用、健康检查正常
```

#### 测试 2: 带 Origin 头的请求
```
请求: curl -H "Origin: https://example.com" http://localhost:6688/
状态: ✓ 200 OK
CORS: Access-Control-Allow-Origin: https://example.com
说明: 返回具体 Origin 而不是 *，支持 credentials
```

#### 测试 3: 预检请求（OPTIONS）
```
请求: curl -X OPTIONS -H "Origin: https://example.com" http://localhost:6688/
状态: ✓ 204 No Content
CORS: 完整的 CORS 响应头
说明: 预检请求正确处理
```

#### 测试 4: 带 credentials 的请求
```
请求: curl -H "Origin: https://example.com" -H "Cookie: session=abc123" http://localhost:6688/
状态: ✓ 200 OK
CORS: Access-Control-Allow-Credentials: true
说明: credentials 请求正确处理
```

#### 测试 5: API 路由
```
请求: curl -H "Origin: https://example.com" http://localhost:6688/all
状态: ✓ 200 OK
CORS: Access-Control-Allow-Origin: https://example.com
说明: API 路由 CORS 正常
```

#### 测试 6: robots.txt
```
请求: curl http://localhost:6688/robots.txt
状态: ✓ 200 OK
Content-Type: text/plain; charset=UTF-8
说明: 静态资源正常访问
```

## 配置组合测试

### 场景 1: ALLOWED_DOMAIN="*"
- **行为**: 允许所有来源
- **响应**: Access-Control-Allow-Origin: <具体 origin> 或 *
- **日志**: "All origins allowed (ALLOWED_DOMAIN=*)"

### 场景 2: ALLOWED_HOST="example.com", ALLOWED_DOMAIN=""
- **行为**: 只允许 example.com 及其子域名
- **响应**: Access-Control-Allow-Origin: https://example.com 或 https://api.example.com
- **日志**: "Matches ALLOWED_HOST" 或 "Subdomain of ALLOWED_HOST"

### 场景 3: ALLOWED_DOMAIN="https://a.com,https://b.com"
- **行为**: 只允许指定的域名列表
- **响应**: Access-Control-Allow-Origin: https://a.com 或 https://b.com
- **日志**: "Matches ALLOWED_DOMAIN"

### 场景 4: 无 Origin 头
- **行为**: 允许请求（非浏览器请求）
- **响应**: 根据配置设置 CORS 头
- **日志**: "No origin header (non-browser request)"

### 场景 5: 非法 Origin
- **行为**: 拒绝请求
- **响应**: 403 Forbidden
- **日志**: "Origin not allowed: <origin>"

## CORS 响应头说明

所有 CORS 响应都包含以下头：

```
Access-Control-Allow-Origin: <origin> 或 *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Custom-Header, Upgrade-Insecure-Requests
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

## 日志输出示例

### 合法请求
```
DEBUG ✓ [CORS] All origins allowed (ALLOWED_DOMAIN=*) | Origin: https://example.com
DEBUG ✓ [CORS] Preflight request allowed | Origin: https://example.com
```

### 非法请求
```
WARN  ✗ [CORS] Origin not allowed: https://evil.com | Method: GET
ERROR ❌ [CORS] Request denied | Origin: https://evil.com | Path: /api/data | Method: GET
```

### 无 Origin 请求
```
DEBUG ✓ [CORS] No origin header (non-browser request) | Origin: none
```

## 不受影响的路由

以下路由保持正常访问：
- ✓ 首页 (`/`)
- ✓ robots.txt (`/robots.txt`)
- ✓ 静态资源 (`/favicon.ico`, `/favicon.png` 等)
- ✓ 聚合 API (`/all`)
- ✓ 所有热榜 API (`/routes/*`)

## 向后兼容性

### 默认配置
```env
ALLOWED_DOMAIN="*"
ALLOWED_HOST="imsyy.top"
```

在此配置下：
- 所有来源都被允许（因为 ALLOWED_DOMAIN="*"）
- ALLOWED_HOST 被忽略

### 严格模式配置
```env
ALLOWED_DOMAIN=""
ALLOWED_HOST="example.com"
```

在此配置下：
- 只允许 example.com 及其子域名
- 同源请求被允许
- 其他来源被拒绝

## 总结

所有测试场景均通过验证：
- ✓ 无 Origin 头的请求正常处理
- ✓ 同源、合法子域名、非法来源、空来源正确区分
- ✓ ALLOWED_DOMAIN 和 ALLOWED_HOST 组合逻辑清晰
- ✓ 预检请求和 credentials 请求正确处理
- ✓ 错误日志详细且易于定位
- ✓ 不影响现有路由和静态资源
