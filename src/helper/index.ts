import path from "path";
import swaggerJSDoc from "swagger-jsdoc"
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const swaggerDefinition = {


    openapi: '3.0.0',
    info: {
        title: 'E-Commerce API Documentation',
        version: '1.0',
        description: 'API for product management',
    },
    // servers: [
    //     {
    //         url: process.env.NEXTAUTH_URL || 'http://localhost:3000',
    //         description: 'Development server',
    //     },
    // ],
    components: {
        securitySchemes: {
            BearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
            },
        },
    },
    security: [],
};

const options = {
    swaggerDefinition,
    apis: [path.join(__dirname, '../routes/*.js')], // Path to the API routes in your Node.js application
};
const swaggerSpec = swaggerJSDoc(options);
export default swaggerSpec;