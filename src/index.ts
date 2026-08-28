import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth } from './routes/auth';
import { products } from './routes/products';
import { categories } from './routes/categories';
import { subcategories } from './routes/subcategories';
import { testimonials, adminTestimonials } from './routes/testimonials';
import { orders } from './routes/orders';
import { users } from './routes/users';
import { images } from './routes/images';
import { stock } from './routes/stock';
import { sales } from './routes/sales';

type Bindings = {
  DATABASE_URL: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  ALLOWED_ORIGINS: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
  const allowedOrigins = (c.env.ALLOWED_ORIGINS ?? 'http://localhost:5174').split(',');
  const requestOrigin = c.req.header('Origin') ?? '';
  const origin = allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0];
  return cors({
    origin,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })(c, next);
});

app.route('/api/auth', auth);
app.route('/api/products', products);
app.route('/api/categories', categories);
app.route('/api/subcategories', subcategories);
app.route('/api/testimonials', testimonials);
app.route('/api/admin/testimonials', adminTestimonials);
app.route('/api/orders', orders);
app.route('/api/users', users);
app.route('/api/images', images);
app.route('/api/stock', stock);
app.route('/api/sales', sales);

app.get('/', (c) => c.json({ status: 'ok', service: 'Alexandra Jewelry API v2' }));

export default app;
