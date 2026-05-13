#!/bin/bash

# Load environment variables
source .env

echo "Testing OpenAI API configuration..."
echo "Base URL: $OPENAI_BASE_URL"
echo "Model: $OPENAI_MODEL"
echo "API Key: ${OPENAI_API_KEY:0:10}..."
echo ""

# Test API call
curl -X POST "$OPENAI_BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "'"$OPENAI_MODEL"'",
    "messages": [
      {
        "role": "user",
        "content": "Say hello"
      }
    ],
    "max_tokens": 10
  }' \
  -w "\n\nHTTP Status: %{http_code}\n"
