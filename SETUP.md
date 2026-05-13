# 配置指南

## API 配置

### 选项 1: OpenAI 官方 API

1. 访问 https://platform.openai.com/api-keys
2. 创建新的 API 密钥
3. 在 `.env` 中配置：

```env
OPENAI_BASE_URL="https://api.openai.com/v1"
OPENAI_API_KEY="sk-your-actual-api-key-here"
OPENAI_MODEL="gpt-4o-mini"
```

### 选项 2: OpenRouter (支持多种模型)

1. 访问 https://openrouter.ai/keys
2. 创建 API 密钥
3. 在 `.env` 中配置：

```env
OPENAI_BASE_URL="https://openrouter.ai/api/v1"
OPENAI_API_KEY="sk-or-v1-your-api-key-here"
OPENAI_MODEL="openai/gpt-4o-mini"
# 或使用免费模型
# OPENAI_MODEL="meta-llama/llama-3.2-3b-instruct:free"
```

### 选项 3: 其他兼容 OpenAI API 的服务

任何兼容 OpenAI API 格式的服务都可以使用，只需配置正确的 `OPENAI_BASE_URL` 和 `OPENAI_API_KEY`。

## 测试 API 配置

运行测试脚本验证配置：

```bash
./test-openai.sh
```

如果看到成功响应（HTTP 200），说明配置正确。

## 常见问题

### 401 Unauthorized
- 检查 API 密钥是否正确
- 确认 API 密钥没有过期
- 验证 `OPENAI_BASE_URL` 与你的 API 提供商匹配

### 模型不存在
- 确认模型名称正确
- 对于 OpenRouter，使用格式：`provider/model-name`
- 对于 OpenAI，使用：`gpt-4o-mini`, `gpt-4o`, `gpt-3.5-turbo` 等

### 代理设置
如果需要使用代理访问 API：

```env
HTTPS_PROXY=http://127.0.0.1:7890
```

## 当前配置检查

你的 `.env` 文件显示：
- Base URL: `https://api.openai.com/v1`
- Model: `minimax/minimax-m2.5:free`

这个配置不匹配！`minimax/minimax-m2.5:free` 看起来像是 OpenRouter 的模型格式，但 Base URL 指向 OpenAI。

**建议修改为以下之一：**

### 使用 OpenAI
```env
OPENAI_BASE_URL="https://api.openai.com/v1"
OPENAI_API_KEY="sk-your-openai-key"
OPENAI_MODEL="gpt-4o-mini"
```

### 使用 OpenRouter
```env
OPENAI_BASE_URL="https://openrouter.ai/api/v1"
OPENAI_API_KEY="sk-or-v1-your-openrouter-key"
OPENAI_MODEL="openai/gpt-4o-mini"
```
