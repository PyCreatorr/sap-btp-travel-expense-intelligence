import dotenv from "dotenv";
dotenv.config();

export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-5.2",
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE || "0.2")
  }
};