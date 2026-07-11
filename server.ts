import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { db } from './src/db/index.ts';
import { books, borrowings, users } from './src/db/schema.ts';
import { eq, or, ilike, and, sql } from 'drizzle-orm';
import { requireAuth, requireAdmin, AuthRequest } from './src/middleware/auth.ts';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for parsing JSON requests
  app.use(express.json());

  // ==================== API ROUTES ====================

  // 1. PUBLIC: List and search books
  app.get('/api/books', async (req, res) => {
    try {
      const search = req.query.search as string;
      const genre = req.query.genre as string;

      const conditions = [];

      if (genre) {
        conditions.push(eq(books.genre, genre));
      }

      if (search) {
        conditions.push(
          or(
            ilike(books.title, `%${search}%`),
            ilike(books.author, `%${search}%`),
            ilike(books.isbn, `%${search}%`),
            ilike(books.genre, `%${search}%`)
          )
        );
      }

      let results;
      if (conditions.length > 0) {
        results = await db.select().from(books).where(and(...conditions)).orderBy(books.title);
      } else {
        results = await db.select().from(books).orderBy(books.title);
      }

      res.json(results);
    } catch (err) {
      console.error('Failed to list books:', err);
      res.status(500).json({ error: 'Failed to retrieve books from database' });
    }
  });

  // 2. PUBLIC: Get book details by ID
  app.get('/api/books/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid book ID' });
      }

      const bookList = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (bookList.length === 0) {
        return res.status(404).json({ error: 'Book not found' });
      }

      res.json(bookList[0]);
    } catch (err) {
      console.error('Failed to get book:', err);
      res.status(500).json({ error: 'Failed to retrieve book' });
    }
  });

  // 3. ADMIN: Add a new book
  app.post('/api/books', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const { title, author, isbn, genre, description, quantity, coverUrl } = req.body;
      if (!title || !author || !isbn) {
        return res.status(400).json({ error: 'Title, author, and ISBN are required' });
      }

      // Check unique ISBN
      const existing = await db.select().from(books).where(eq(books.isbn, isbn)).limit(1);
      if (existing.length > 0) {
        return res.status(400).json({ error: 'A book with this ISBN already exists' });
      }

      const newBook = await db.insert(books).values({
        title,
        author,
        isbn,
        genre,
        description,
        quantity: quantity !== undefined ? parseInt(quantity) : 1,
        availableQuantity: quantity !== undefined ? parseInt(quantity) : 1,
        coverUrl: coverUrl || null,
      }).returning();

      res.status(201).json(newBook[0]);
    } catch (err) {
      console.error('Failed to create book:', err);
      res.status(500).json({ error: 'Failed to create new book' });
    }
  });

  // 4. ADMIN: Update book details
  app.put('/api/books/:id', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid book ID' });
      }

      const { title, author, isbn, genre, description, quantity, coverUrl } = req.body;
      if (!title || !author || !isbn) {
        return res.status(400).json({ error: 'Title, author, and ISBN are required' });
      }

      const existingList = await db.select().from(books).where(eq(books.id, id)).limit(1);
      if (existingList.length === 0) {
        return res.status(404).json({ error: 'Book not found' });
      }
      const existingBook = existingList[0];

      // Re-calculate available quantity based on updated total quantity
      const newTotalQty = parseInt(quantity !== undefined ? quantity : existingBook.quantity);
      const qtyDiff = newTotalQty - existingBook.quantity;
      const newAvailableQty = Math.max(0, existingBook.availableQuantity + qtyDiff);

      const updated = await db.update(books).set({
        title,
        author,
        isbn,
        genre,
        description,
        quantity: newTotalQty,
        availableQuantity: newAvailableQty,
        coverUrl: coverUrl || null,
        updatedAt: new Date(),
      }).where(eq(books.id, id)).returning();

      res.json(updated[0]);
    } catch (err) {
      console.error('Failed to update book:', err);
      res.status(500).json({ error: 'Failed to update book' });
    }
  });

  // 5. ADMIN: Delete a book
  app.delete('/api/books/:id', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid book ID' });
      }

      // Check if book has active borrowings
      const activeBorrowings = await db.select().from(borrowings).where(
        and(
          eq(borrowings.bookId, id),
          eq(borrowings.status, 'borrowed')
        )
      );

      if (activeBorrowings.length > 0) {
        return res.status(400).json({ error: 'Cannot delete book: there are active, unreturned borrowings.' });
      }

      // Delete historical borrowing logs first
      await db.delete(borrowings).where(eq(borrowings.bookId, id));
      await db.delete(books).where(eq(books.id, id));

      res.json({ message: 'Book deleted successfully' });
    } catch (err) {
      console.error('Failed to delete book:', err);
      res.status(500).json({ error: 'Failed to delete book' });
    }
  });

  // 6. AUTHENTICATED: Borrow a book
  app.post('/api/books/:id/borrow', requireAuth, async (req: AuthRequest, res) => {
    try {
      const bookId = parseInt(req.params.id);
      if (isNaN(bookId)) {
        return res.status(400).json({ error: 'Invalid book ID' });
      }

      const dbUser = req.dbUser;
      if (!dbUser) {
        return res.status(401).json({ error: 'Database user profile not synchronized' });
      }

      // Check book stock and availability
      const bookList = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (bookList.length === 0) {
        return res.status(404).json({ error: 'Book not found' });
      }
      const book = bookList[0];

      if (book.availableQuantity <= 0) {
        return res.status(400).json({ error: 'This book is currently out of stock.' });
      }

      // Check if the user already has an active borrowing of this book
      const alreadyBorrowed = await db.select().from(borrowings).where(
        and(
          eq(borrowings.userId, dbUser.id),
          eq(borrowings.bookId, bookId),
          eq(borrowings.status, 'borrowed')
        )
      ).limit(1);

      if (alreadyBorrowed.length > 0) {
        return res.status(400).json({ error: 'You are currently borrowing this book. Please return it before borrowing again.' });
      }

      // Check total active borrowing limit (max 5)
      const currentActive = await db.select().from(borrowings).where(
        and(
          eq(borrowings.userId, dbUser.id),
          eq(borrowings.status, 'borrowed')
        )
      );

      if (currentActive.length >= 5) {
        return res.status(400).json({ error: 'Borrowing limit reached. You can borrow a maximum of 5 books at a time.' });
      }

      // Set standard borrowing due date (14 days from now)
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 14);

      // Perform atomic database transaction to update stock and insert borrowing log
      const result = await db.transaction(async (tx) => {
        await tx.update(books)
          .set({ availableQuantity: book.availableQuantity - 1 })
          .where(eq(books.id, bookId));

        const borrowRecord = await tx.insert(borrowings).values({
          userId: dbUser.id,
          bookId: bookId,
          dueDate: dueDate,
          status: 'borrowed',
        }).returning();

        return borrowRecord[0];
      });

      res.status(201).json(result);
    } catch (err) {
      console.error('Failed to borrow book:', err);
      res.status(500).json({ error: 'Failed to borrow book' });
    }
  });

  // 7. AUTHENTICATED: Return a borrowed book
  app.post('/api/borrowings/:id/return', requireAuth, async (req: AuthRequest, res) => {
    try {
      const borrowingId = parseInt(req.params.id);
      if (isNaN(borrowingId)) {
        return res.status(400).json({ error: 'Invalid borrowing ID' });
      }

      const dbUser = req.dbUser;
      if (!dbUser) {
        return res.status(401).json({ error: 'Database user profile not synchronized' });
      }

      const borrowingList = await db.select().from(borrowings).where(eq(borrowings.id, borrowingId)).limit(1);
      if (borrowingList.length === 0) {
        return res.status(404).json({ error: 'Borrowing record not found' });
      }
      const record = borrowingList[0];

      // Safety check: normal users can only return their own books
      if (record.userId !== dbUser.id && dbUser.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: You cannot return another user\'s book' });
      }

      if (record.status === 'returned') {
        return res.status(400).json({ error: 'This book has already been returned.' });
      }

      // Transaction to return the book
      await db.transaction(async (tx) => {
        // Fetch book to make sure we don't exceed total quantity
        const bookList = await tx.select().from(books).where(eq(books.id, record.bookId)).limit(1);
        if (bookList.length > 0) {
          const book = bookList[0];
          await tx.update(books)
            .set({ availableQuantity: Math.min(book.quantity, book.availableQuantity + 1) })
            .where(eq(books.id, record.bookId));
        }

        await tx.update(borrowings)
          .set({
            status: 'returned',
            returnDate: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(borrowings.id, borrowingId));
      });

      res.json({ message: 'Book returned successfully' });
    } catch (err) {
      console.error('Failed to return book:', err);
      res.status(500).json({ error: 'Failed to return book' });
    }
  });

  // 8. AUTHENTICATED: Get user profile, history, and system statistics
  app.get('/api/profile', requireAuth, async (req: AuthRequest, res) => {
    try {
      const dbUser = req.dbUser;
      if (!dbUser) {
        return res.status(401).json({ error: 'Database user profile not synchronized' });
      }

      // Fetch user's borrowings with book details
      const history = await db.select({
        borrowingId: borrowings.id,
        borrowDate: borrowings.borrowDate,
        dueDate: borrowings.dueDate,
        returnDate: borrowings.returnDate,
        status: borrowings.status,
        book: {
          id: books.id,
          title: books.title,
          author: books.author,
          isbn: books.isbn,
          genre: books.genre,
          coverUrl: books.coverUrl,
        }
      })
      .from(borrowings)
      .innerJoin(books, eq(borrowings.bookId, books.id))
      .where(eq(borrowings.userId, dbUser.id))
      .orderBy(sql`${borrowings.borrowDate} DESC`);

      res.json({
        user: dbUser,
        borrowings: history
      });
    } catch (err) {
      console.error('Failed to load profile:', err);
      res.status(500).json({ error: 'Failed to retrieve profile data' });
    }
  });

  // 8.5 AUTHENTICATED: Update user's reading goal
  app.put('/api/profile/goal', requireAuth, async (req: AuthRequest, res) => {
    try {
      const dbUser = req.dbUser;
      if (!dbUser) {
        return res.status(401).json({ error: 'Database user profile not synchronized' });
      }

      const { readingGoal } = req.body;
      if (readingGoal === undefined || readingGoal === null) {
        return res.status(400).json({ error: 'Reading goal is required' });
      }

      const goal = parseInt(readingGoal);
      if (isNaN(goal) || goal < 1) {
        return res.status(400).json({ error: 'Reading goal must be a positive integer' });
      }

      const updated = await db.update(users)
        .set({ readingGoal: goal })
        .where(eq(users.id, dbUser.id))
        .returning();

      res.json(updated[0]);
    } catch (err) {
      console.error('Failed to update reading goal:', err);
      res.status(500).json({ error: 'Failed to update reading goal' });
    }
  });

  // 9. ADMIN: List all synchronized users
  app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
      const userList = await db.select().from(users).orderBy(users.id);
      res.json(userList);
    } catch (err) {
      console.error('Failed to list users:', err);
      res.status(500).json({ error: 'Failed to retrieve user list' });
    }
  });

  // 10. ADMIN: Update user role (admin vs user)
  app.put('/api/admin/users/:id/role', requireAdmin, async (req: AuthRequest, res) => {
    try {
      const targetUserId = parseInt(req.params.id);
      if (isNaN(targetUserId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }

      const { role } = req.body;
      if (role !== 'admin' && role !== 'user') {
        return res.status(400).json({ error: 'Role must be either admin or user' });
      }

      // Prevent demoting yourself
      if (req.dbUser && req.dbUser.id === targetUserId && role !== 'admin') {
        return res.status(400).json({ error: 'You cannot revoke your own admin rights.' });
      }

      const updated = await db.update(users)
        .set({ role })
        .where(eq(users.id, targetUserId))
        .returning();

      res.json(updated[0]);
    } catch (err) {
      console.error('Failed to update user role:', err);
      res.status(500).json({ error: 'Failed to update user role' });
    }
  });

  // 11. ADMIN: List all borrowings in the library
  app.get('/api/admin/borrowings', requireAdmin, async (req, res) => {
    try {
      const allHistory = await db.select({
        borrowingId: borrowings.id,
        borrowDate: borrowings.borrowDate,
        dueDate: borrowings.dueDate,
        returnDate: borrowings.returnDate,
        status: borrowings.status,
        user: {
          id: users.id,
          email: users.email,
          displayName: users.displayName,
        },
        book: {
          id: books.id,
          title: books.title,
          author: books.author,
          isbn: books.isbn,
        }
      })
      .from(borrowings)
      .innerJoin(books, eq(borrowings.bookId, books.id))
      .innerJoin(users, eq(borrowings.userId, users.id))
      .orderBy(sql`${borrowings.borrowDate} DESC`);

      res.json(allHistory);
    } catch (err) {
      console.error('Failed to fetch borrowing logs:', err);
      res.status(500).json({ error: 'Failed to retrieve borrowing logs' });
    }
  });

  // ==================== FRONTEND BINDING ====================

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Library Management System running on port ${PORT}`);
  });
}

startServer();
