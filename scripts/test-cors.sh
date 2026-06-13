#!/bin/bash

# CORS 快速验证脚本
# 用法: bash scripts/test-cors.sh

BASE_URL="http://localhost:6688"

echo "🧪 CORS 快速验证脚本"
echo "📡 目标: $BASE_URL"
echo ""

# 检查服务器是否运行
if ! curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/" | grep -q "200"; then
  echo "❌ 服务器未运行，请先启动: npm run dev"
  exit 1
fi

echo "✓ 服务器已运行"
echo ""

# 测试 1: 无 Origin 头（curl）
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "测试 1: 无 Origin 头（curl/服务端调用）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RESPONSE=$(curl -s -I "$BASE_URL/" 2>&1)
STATUS=$(echo "$RESPONSE" | grep -E "HTTP/" | awk '{print $2}')
CORS=$(echo "$RESPONSE" | grep "Access-Control-Allow-Origin" | awk '{print $2}' | tr -d '\r')
echo "状态码: $STATUS"
echo "CORS: $CORS"
if [ "$STATUS" = "200" ]; then
  echo "结果: ✓ 通过"
else
  echo "结果: ✗ 失败"
fi
echo ""

# 测试 2: 带 Origin 头
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "测试 2: 带 Origin 头（浏览器请求）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RESPONSE=$(curl -s -I -H "Origin: https://example.com" "$BASE_URL/" 2>&1)
STATUS=$(echo "$RESPONSE" | grep -E "HTTP/" | awk '{print $2}')
CORS=$(echo "$RESPONSE" | grep "Access-Control-Allow-Origin" | awk '{print $2}' | tr -d '\r')
echo "状态码: $STATUS"
echo "CORS: $CORS"
if [ "$STATUS" = "200" ] && [ "$CORS" = "https://example.com" ]; then
  echo "结果: ✓ 通过"
else
  echo "结果: ✗ 失败"
fi
echo ""

# 测试 3: 预检请求（OPTIONS）
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "测试 3: 预检请求（OPTIONS）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RESPONSE=$(curl -s -I -X OPTIONS -H "Origin: https://example.com" "$BASE_URL/" 2>&1)
STATUS=$(echo "$RESPONSE" | grep -E "HTTP/" | awk '{print $2}')
CORS=$(echo "$RESPONSE" | grep "Access-Control-Allow-Origin" | awk '{print $2}' | tr -d '\r')
echo "状态码: $STATUS"
echo "CORS: $CORS"
if [ "$STATUS" = "204" ] && [ "$CORS" = "https://example.com" ]; then
  echo "结果: ✓ 通过"
else
  echo "结果: ✗ 失败"
fi
echo ""

# 测试 4: 带 credentials
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "测试 4: 带 credentials 的请求"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RESPONSE=$(curl -s -I -H "Origin: https://example.com" -H "Cookie: session=abc123" "$BASE_URL/" 2>&1)
STATUS=$(echo "$RESPONSE" | grep -E "HTTP/" | awk '{print $2}')
CORS=$(echo "$RESPONSE" | grep "Access-Control-Allow-Origin" | awk '{print $2}' | tr -d '\r')
CREDS=$(echo "$RESPONSE" | grep "Access-Control-Allow-Credentials" | awk '{print $2}' | tr -d '\r')
echo "状态码: $STATUS"
echo "CORS: $CORS"
echo "Credentials: $CREDS"
if [ "$STATUS" = "200" ] && [ "$CREDS" = "true" ]; then
  echo "结果: ✓ 通过"
else
  echo "结果: ✗ 失败"
fi
echo ""

# 测试 5: API 路由
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "测试 5: API 路由（/all）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RESPONSE=$(curl -s -I -H "Origin: https://example.com" "$BASE_URL/all" 2>&1)
STATUS=$(echo "$RESPONSE" | grep -E "HTTP/" | awk '{print $2}')
CORS=$(echo "$RESPONSE" | grep "Access-Control-Allow-Origin" | awk '{print $2}' | tr -d '\r')
echo "状态码: $STATUS"
echo "CORS: $CORS"
if [ "$STATUS" = "200" ]; then
  echo "结果: ✓ 通过"
else
  echo "结果: ✗ 失败"
fi
echo ""

# 测试 6: robots.txt
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "测试 6: 静态资源（robots.txt）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RESPONSE=$(curl -s -I "$BASE_URL/robots.txt" 2>&1)
STATUS=$(echo "$RESPONSE" | grep -E "HTTP/" | awk '{print $2}')
CONTENT_TYPE=$(echo "$RESPONSE" | grep "Content-Type" | awk '{print $2}' | tr -d '\r')
echo "状态码: $STATUS"
echo "Content-Type: $CONTENT_TYPE"
if [ "$STATUS" = "200" ]; then
  echo "结果: ✓ 通过"
else
  echo "结果: ✗ 失败"
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ 所有测试完成"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
