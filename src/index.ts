import express from "express";
import swaggerUi from "swagger-ui-express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";

import swaggerSpec from "./helper/index.js";
import routes from './routes/index.js';
import ProductModel from "./db/productModel.js";
import { fileURLToPath } from "url";
import path from "path";
import fs from 'fs'

dotenv.config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/', routes);

app.get('/', (req, res) => {
  res.send({ message: "product apis" });
});

// Swagger
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Database and Server
mongoose.Promise = Promise;
const PORT = process.env.PORT || 3000;

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// console.log("__dirname:", __dirname);
// console.log("Files in dir:", fs.readdirSync(__dirname));
async function startServer() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("Missing MONGO_URI environment variable");
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log(mongoose.connection.readyState);
    console.log("Connected to MongoDB");
    const aggResult = await ProductModel.aggregate([{ $sample: { size: 5 } }]);
    console.log("Aggregation sample:", aggResult);

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}/`);
      console.log(`${process.env.NODE_ENV || "development"} mode is running.`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();