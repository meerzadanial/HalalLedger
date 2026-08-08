/**
 * Example: Restaurant Autocomplete API Endpoint
 * 
 * This file demonstrates how to integrate the autocomplete functionality
 * into an Express API endpoint.
 * 
 * DO NOT import this file in production code - it's for reference only.
 */

import { Router, Request, Response } from "express";
import { IncomeService } from "../services";
import { authenticateToken } from "../middleware/auth";

const router = Router();
const incomeService = new IncomeService();

/**
 * GET /api/restaurants/autocomplete
 * 
 * Returns restaurant name suggestions based on search query
 * 
 * Query Parameters:
 * - q: Search query string (required)
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * Response:
 * - 200: Array of restaurant name suggestions (max 10)
 * - 400: Missing or invalid query parameter
 * - 401: Unauthorized (missing or invalid token)
 * - 500: Internal server error
 * 
 * Example Request:
 * GET /api/restaurants/autocomplete?q=pizza
 * Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 * 
 * Example Response:
 * {
 *   "suggestions": ["Pizza Palace", "Pizza Hut"]
 * }
 */
router.get(
  "/autocomplete",
  authenticateToken, // Authenticate user first
  async (req: Request, res: Response) => {
    try {
      // Get search query from query parameters
      const searchQuery = req.query.q as string;

      // Validate query parameter
      if (!searchQuery || typeof searchQuery !== "string") {
        return res.status(400).json({
          error: "Missing or invalid query parameter 'q'",
        });
      }

      // Get user ID from authenticated request
      // The authenticateToken middleware should attach user info to req
      const userId = (req as any).user?.userId;

      if (!userId) {
        return res.status(401).json({
          error: "User not authenticated",
        });
      }

      // Get autocomplete suggestions
      const suggestions = await incomeService.getRestaurantNameSuggestions(
        userId,
        searchQuery
      );

      // Return suggestions
      return res.status(200).json({
        suggestions,
      });
    } catch (error) {
      console.error("Error fetching restaurant suggestions:", error);
      return res.status(500).json({
        error: "Internal server error",
        details:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  }
);

/**
 * Example Frontend Integration
 * 
 * ```typescript
 * // React component with autocomplete
 * const [searchQuery, setSearchQuery] = useState("");
 * const [suggestions, setSuggestions] = useState<string[]>([]);
 * 
 * // Debounce autocomplete API calls
 * useEffect(() => {
 *   const timer = setTimeout(async () => {
 *     if (searchQuery.length >= 2) {
 *       const response = await fetch(
 *         `/api/restaurants/autocomplete?q=${encodeURIComponent(searchQuery)}`,
 *         {
 *           headers: {
 *             'Authorization': `Bearer ${token}`
 *           }
 *         }
 *       );
 *       const data = await response.json();
 *       setSuggestions(data.suggestions);
 *     } else {
 *       setSuggestions([]);
 *     }
 *   }, 300); // 300ms debounce
 * 
 *   return () => clearTimeout(timer);
 * }, [searchQuery]);
 * ```
 */

export default router;
