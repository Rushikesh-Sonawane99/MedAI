import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export function setupAuth(app: Express) {
  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || "mediaisecret2025",
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax"
    }
  };

  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(
      {
        usernameField: 'email',
        passwordField: 'password'
      },
      async (email, password, done) => {
        try {
          const user = await storage.getUserByEmail(email);
          if (!user || !(await comparePasswords(password, user.password))) {
            return done(null, false, { message: "Invalid email or password" });
          } else {
            return done(null, user);
          }
        } catch (error) {
          return done(error);
        }
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user || undefined);
    } catch (error) {
      done(error);
    }
  });

  // API Routes for authentication
  app.post("/api/register", async (req, res, next) => {
    try {
      const { email, password, firstName, lastName } = req.body;
      
      // Check if user already exists
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ message: "Email already in use" });
      }

      // Hash password and create user
      const hashedPassword = await hashPassword(password);
      const user = await storage.createUser({
        email,
        password: hashedPassword,
        firstName,
        lastName
      });

      // Create empty health profile
      await storage.createHealthProfile({
        userId: user.id,
        age: null,
        gender: null,
        height: null,
        weight: null,
        bloodType: null,
        allergies: [],
        chronicConditions: [],
        medications: [],
        familyHistory: [],
        lifestyleHabits: {}
      });

      // Log the user in
      req.login(user, (err) => {
        if (err) return next(err);
        // Don't send password in response
        const { password, ...userWithoutPassword } = user;
        return res.status(201).json(userWithoutPassword);
      });
    } catch (error: any) {
      console.error("Registration error:", error);
      res.status(500).json({ message: `Registration failed: ${error.message}` });
    }
  });

  app.post("/api/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: Express.User | false, info: { message?: string }) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ message: info.message || "Authentication failed" });
      }
      req.login(user, (err) => {
        if (err) return next(err);
        // Don't send password in response
        const { password, ...userWithoutPassword } = user;
        return res.json(userWithoutPassword);
      });
    })(req, res, next);
  });

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.json({ message: "Logged out successfully" });
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    // Don't send password in response
    const { password, ...userWithoutPassword } = req.user as SelectUser;
    res.json(userWithoutPassword);
  });
}