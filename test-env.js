require('dotenv').config();

console.log('Environment variables:');
console.log('OPENAI_BASE_URL:', process.env.OPENAI_BASE_URL);
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY?.substring(0, 15) + '...');
console.log('OPENAI_MODEL:', process.env.OPENAI_MODEL);
