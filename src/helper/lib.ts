import { createHmac } from 'crypto';

import ProductModel from "../db/productModel.js";
import { ProductQueryParams } from '../types/index.js';

export function safeParseInt(value: string | null, defaultValue: number, min = 1, max = 100): number {
    const num = parseInt(value || '');
    return isNaN(num)
        ? defaultValue
        : Math.min(max, Math.max(min, num)); // Clamps between min/max
}


const PAGINATION_SECRET = process.env.PAGINATION_SECRET || 'your-secret-key';

export function encodeCursor(payload: object): string {
    const str = JSON.stringify(payload);
    const hmac = createHmac('sha256', PAGINATION_SECRET);
    const signature = hmac.update(str).digest('hex');
    console.log({ "sign": Buffer.from(`${str}:${signature}`).toString('base64') })
    return Buffer.from(`${str}:${signature}`).toString('base64');
}

export function decodeCursor(token: string): any {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        console.log({ decoded })
        // Split on the last occurrence of '|' since signature won't contain this character
        const lastSeparatorIndex = decoded.lastIndexOf(':');
        console.log({ lastSeparatorIndex })
        if (lastSeparatorIndex === -1) {
            throw new Error('Invalid cursor format');
        }

        const str = decoded.slice(0, lastSeparatorIndex);
        const signature = decoded.slice(lastSeparatorIndex + 1);

        const hmac = createHmac('sha256', PAGINATION_SECRET);
        const expectedSignature = hmac.update(str).digest('hex');
        console.log("the decodes", { expectedSignature }, { signature })
        if (signature !== expectedSignature) {
            throw new Error('Invalid cursor signature');
        }

        return JSON.parse(str);
    } catch (error) {
        console.error('Cursor decoding failed:', error);
        throw new Error('Invalid cursor');
    }
}

export function buildFilters(params: ProductQueryParams) {
    const filter: Record<string, any> = {};

    if (params.search) {
        filter.$or = [
            { name: { $regex: params.search, $options: 'i' } },
            { description: { $regex: params.search, $options: 'i' } }
        ];
    }

    if (params.category) filter.category = params.category;
    if (params.type) filter.type = params.type;

    const minPrice = parseFloat(params.minPrice || '0');
    const maxPrice = parseFloat(params.maxPrice || '100000');
    filter.price = { $gte: minPrice, $lte: maxPrice };

    return filter;
}
export const seedProducts = async (productsData: any[]) => {
    try {


        // Using Promise.all for parallel creation
        const creationPromises = productsData.map(product =>
            ProductModel.create(product).catch((error: any) => ({
                error: true,
                product: product.name,
                message: error.message
            }))
        );

        const results = await Promise.all(creationPromises);

        // Check for any errors in the results
        const errors = results.filter((result: any) => result?.error);
        if (errors.length > 0) {
            console.error('Some products failed to create:', errors);
            return {
                success: false,
                created: results.length - errors.length,
                errors
            };
        }

        return {
            success: true,
            created: results.length
        };
    } catch (error) {
        console.error('Bulk creation failed:', error);
        throw error;
    }
};
