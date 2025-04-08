import mongoose, { Schema } from "mongoose";
import { IProduct } from "../types";
const productSchema = new Schema<IProduct>(
    {
        name: { type: String, required: true, trim: true },
        price: { type: Number, required: true, min: 0 },
        category: {
            type: String,
            enum: ["Electronics", "Fashion", "Grocery", "Books", "Furniture"],
            required: true,
        },
        type: { type: String, enum: ["physical", "digital", "service"], default: "physical" },
        description: { type: String, trim: true },
        images: { type: [String], default: [] },
    },
    { timestamps: true }
);


const ProductModel = mongoose.models.Product || mongoose.model<IProduct>("Product", productSchema);

export default ProductModel;
