import { ProductQueryParams } from "../types/index.js";
import { buildFilters, decodeCursor, encodeCursor, safeParseInt } from "../helper/lib.js";
import ProductModel from "../db/productModel.js";
import { Request } from "express";

class ProductController {

    async getProducts(req: Request) {
        try {
            console.log(req.query)
            const searchParams = req.query as unknown as ProductQueryParams;
            console.log({ searchParams })
            const limitParam = searchParams.limit !== undefined ? searchParams.limit : null;
            const limit = safeParseInt(limitParam, 12, 1, 100);
            let nextPageToken = searchParams.pageToken;
            console.log({ nextPageToken })

            let cursorQuery = {};
            if (nextPageToken) {
                try {
                    const decoded = await decodeCursor(nextPageToken);
                    cursorQuery = { _id: { $gt: decoded._id } };
                } catch (error) {
                    throw new Error("Invalid nextPageToken")
                }
            }

            // Build filters
            const filter = buildFilters(searchParams);
            console.log({ filter })

            // Fetch products
            const products = await ProductModel.find({ ...filter, ...cursorQuery }, { __v: 0 })
                .sort({ _id: 1 })
                .limit(limit + 1)
                .lean();
            console.log({ products })
            // Check if there's more data
            const hasNextPage = products.length > limit;
            const items = hasNextPage ? products.slice(0, -1) : products;

            // Generate next page token if there are more items
            nextPageToken = null;
            if (hasNextPage && items.length > 0) {
                const lastItem = items[items.length - 1];
                nextPageToken = encodeCursor({ _id: lastItem._id });
            }

            // Get total count for pagination (replace hardcoded 41)
            const total = await ProductModel.countDocuments(filter);

            const response = {
                success: true,
                data: items,
                total,
                pagination: {
                    limit,
                    nextPageToken,
                    hasNextPage
                }
            }
            return response

        } catch (error) {
            console.error('Error in products route:', error);
            throw new Error("Internal Server Error")

        }
    }
    async createProduct(Req: Request) {
        const data = {
            name:
                "Nothing 2A",
            price:
                "29",
            category:
                "Electronics",
            type:
                "physical",
            description:
                "Latest Apple iPhone",

            images: ["https://in.nothing.tech/cdn/shop/files/Desktop_Sept_10_1472x.jpg?v=1725959737"]

        }

        const create = await ProductModel.create(data)
        console.log({ create })
        return create
    }






}

const productController = new ProductController()
export default productController