import {
  pgTable,
  text,
  boolean,
  integer,
  serial,
  timestamp,
  jsonb,
  customType,
} from 'drizzle-orm/pg-core';

// Money is stored as exact numeric(12,2) and exposed to the app as a number.
const money = customType<{ data: number; driverData: string | number }>({
  dataType: () => 'numeric(12, 2)',
  fromDriver: (value) => Number(value),
  toDriver: (value) => String(value),
});

// ─── Users ────────────────────────────────────────────────────────────────────

export const usersTable = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'), // prepared for future roles
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Categories ───────────────────────────────────────────────────────────────

export const categoriesTable = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  nameEn: text('name_en').notNull().default(''),
  slug: text('slug').notNull().unique(),
  image: text('image').notNull().default(''),
  description: text('description').notNull().default(''),
  descriptionEn: text('description_en').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Subcategories ────────────────────────────────────────────────────────────

export const subcategoriesTable = pgTable('subcategories', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').notNull().references(() => categoriesTable.id),
  name: text('name').notNull(),
  nameEn: text('name_en').notNull().default(''),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull().default(''),
  descriptionEn: text('description_en').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Products ─────────────────────────────────────────────────────────────────

export const productsTable = pgTable('products', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  nameEn: text('name_en').notNull().default(''),
  slug: text('slug').notNull().unique(),
  categoryId: integer('category_id').notNull().references(() => categoriesTable.id),
  subcategoryId: integer('subcategory_id').notNull().references(() => subcategoriesTable.id),
  description: text('description').notNull().default(''),
  descriptionEn: text('description_en').notNull().default(''),
  cost: money('cost'),          // optional, internal use
  price: money('price').notNull(),
  tax: money('tax').notNull().default(0),
  stock: integer('stock').notNull().default(0),
  minStock: integer('min_stock').notNull().default(0),
  featured: boolean('featured').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Product Images ───────────────────────────────────────────────────────────

export const productImagesTable = pgTable('product_images', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => productsTable.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  data: text('data'),                     // base64 data URI when uploaded via API
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Testimonials ─────────────────────────────────────────────────────────────

export const testimonialsTable = pgTable('testimonials', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  location: text('location').notNull().default(''),
  locationEn: text('location_en').notNull().default(''),
  rating: integer('rating').notNull().default(5),
  text: text('text').notNull(),
  textEn: text('text_en').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Stock Movements ─────────────────────────────────────────────────────────

export const stockProductsTable = pgTable('stock_products', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => productsTable.id),
  quantity: integer('quantity').notNull(),             // positive = entry, negative = removal
  type: text('type').notNull().default('entry'),       // entry | adjustment | return
  notes: text('notes').notNull().default(''),
  createdBy: text('created_by').notNull().default(''),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Sales ────────────────────────────────────────────────────────────────────

export const salesTable = pgTable('sales', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => productsTable.id),
  productName: text('product_name').notNull(),
  quantity: integer('quantity').notNull(),
  unitPrice: money('unit_price').notNull(),
  total: money('total').notNull(),
  notes: text('notes').notNull().default(''),
  soldBy: text('sold_by').notNull().default(''),
  // Set when the sale comes from a web order (it took the order's stock)
  orderId: integer('order_id').references(() => ordersTable.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Orders ───────────────────────────────────────────────────────────────────

export const ordersTable = pgTable('orders', {
  id: serial('id').primaryKey(),
  customerName: text('customer_name').notNull(),
  customerPhone: text('customer_phone').notNull(),
  customerAddress: text('customer_address').notNull().default(''),
  customerCity: text('customer_city').notNull().default(''),
  notes: text('notes').notNull().default(''),
  paymentMethod: text('payment_method').notNull(),
  items: jsonb('items').notNull(),
  total: money('total').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
