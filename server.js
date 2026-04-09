const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ✅ RDS MySQL Connection Pool (credentials kept in code)
const db = mysql.createPool({
    host: 'moviedb.cmpmaac422xa.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'prashu264',
    database: 'moviedb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test DB connection
db.getConnection((err, connection) => {
    if (err) {
        console.error('Database connection failed:', err);
    } else {
        console.log('Connected to RDS MySQL');
        connection.release();
    }
});

/**
 * Utility function to group posters with their respective movie.
 * Since JOIN returns multiple rows for the same movie (one per poster),
 * this function consolidates them into a single movie object.
 */
function groupMovies(rows) {
    const moviesMap = {};

    rows.forEach(row => {
        if (!moviesMap[row.id]) {
            moviesMap[row.id] = {
                id: row.id,
                title: row.title,
                description: row.description,
                release_year: row.release_year,
                rating: row.rating,
                director: row.director,
                cast: row.cast,
                genre: row.genre,
                duration: row.duration,
                posters: []
            };
        }

        if (row.poster_url) {
            moviesMap[row.id].posters.push(row.poster_url);
        }
    });

    return Object.values(moviesMap);
}

//
// 🎬 1. Get a single movie by name
//
app.get('/movie', (req, res) => {
    const name = req.query.name;

    if (!name) {
        return res.status(400).json({ message: "Please provide movie name" });
    }

    const query = `
        SELECT 
            m.id, m.title, m.description, m.release_year, m.rating,
            m.director, m.cast, m.genre, m.duration,
            p.poster_url
        FROM movies m
        LEFT JOIN posters p ON m.id = p.movie_id
        WHERE m.title LIKE ?
        ORDER BY m.title;
    `;

    db.query(query, [`%${name}%`], (err, rows) => {
        if (err) {
            console.error('Error fetching movie:', err);
            return res.status(500).json({ error: "Database error" });
        }

        if (rows.length === 0) {
            return res.status(404).json({ message: "Movie not found" });
        }

        const movies = groupMovies(rows);

        // Return the first matched movie
        res.json(movies[0]);
    });
});

//
// 🎬 2. Get ALL movies
//
app.get('/movies', (req, res) => {
    const query = `
        SELECT 
            m.id, m.title, m.description, m.release_year, m.rating,
            m.director, m.cast, m.genre, m.duration,
            p.poster_url
        FROM movies m
        LEFT JOIN posters p ON m.id = p.movie_id
        ORDER BY m.title;
    `;

    db.query(query, (err, rows) => {
        if (err) {
            console.error('Error fetching movies:', err);
            return res.status(500).json({ error: "Database error" });
        }

        const movies = groupMovies(rows);
        res.json(movies);
    });
});

//
// ➕ 3. Add a new movie (optional feature)
//
app.post('/movies', (req, res) => {
    const {
        title,
        description,
        release_year,
        rating,
        director,
        cast,
        genre,
        duration,
        posters = []
    } = req.body;

    if (!title) {
        return res.status(400).json({ message: "Title is required" });
    }

    const movieQuery = `
        INSERT INTO movies 
        (title, description, release_year, rating, director, cast, genre, duration)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
        movieQuery,
        [title, description, release_year, rating, director, cast, genre, duration],
        (err, result) => {
            if (err) {
                console.error('Error inserting movie:', err);
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ message: "Movie already exists" });
                }
                return res.status(500).json({ error: "Failed to insert movie" });
            }

            const movieId = result.insertId;

            if (posters.length === 0) {
                return res.status(201).json({
                    message: "Movie added successfully",
                    movieId
                });
            }

            const posterValues = posters.map(url => [movieId, url]);
            const posterQuery =
                "INSERT INTO posters (movie_id, poster_url) VALUES ?";

            db.query(posterQuery, [posterValues], (err) => {
                if (err) {
                    console.error('Error inserting posters:', err);
                    return res.status(500).json({
                        error: "Movie added but failed to insert posters"
                    });
                }

                res.status(201).json({
                    message: "Movie and posters added successfully",
                    movieId
                });
            });
        }
    );
});

//
// 🚀 Start the server
//
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
