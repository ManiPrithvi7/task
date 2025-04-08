/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get a list of users
 *     description: Retrieve a list of users from the database.
 *     responses:
 *       200:
 *         description: Successful response with a list of users.
 */
import express from 'express'
import productController from '../controller/productController.js';

const router = express.Router()
router.get('users', (req, res) => {
    // Your logic to fetch and return users
    res.json({ users: [] });
});
router.get('/products', async (req, res) => {

    try {
        const data = await productController.getProducts(req);
        // const data = await productController.createProduct(req);
        res.status(200).json(data);
    } catch (err: any) {
        console.log(err);
        res.status(500).send({
            message: err.message,
        });
    }

})



export default router