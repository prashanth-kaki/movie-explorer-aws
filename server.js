const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));
// RDS Connection
const db = mysql.createConnection({
    host: 'moviedb.cmpmaac422xa.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'prashu264',
    database: 'moviedb'
});

// Connect to DB
db.connect(err => {
    if (err) {
        console.error("Database connection failed:", err);
    } else {
        console.log("Connected to RDS MySQL");
    }
});


// 🎬 1. Get single movie by name
app.get('/movie', (req, res) => {
    const name = req.query.name;

    if (!name) {
        return res.json({ message: "Please provide movie name" });
    }

    db.query(
        "SELECT * FROM movies WHERE title LIKE ?",
        [`%${name}%`],
        (err, movieResult) => {

            if (err) {
                return res.json({ error: err });
            }

            if (movieResult.length === 0) {
                return res.json({ message: "Movie not found" });
            }

            const movie = movieResult[0];

            db.query(
                "SELECT poster_url FROM posters WHERE movie_id = ?",
                [movie.id],
                (err, posters) => {

                    if (err) {
                        return res.json({ error: err });
                    }

                    res.json({
                        ...movie,
                        posters: posters.map(p => p.poster_url)
                    });
                }
            );
        }
    );
});


// 🎬 2. Get ALL movies (🔥 bonus feature)
app.get('/movies', (req, res) => {

    db.query("SELECT * FROM movies", (err, movies) => {

        if (err) {
            return res.json({ error: err });
        }

        // For each movie → attach posters
        const promises = movies.map(movie => {
            return new Promise((resolve, reject) => {
                db.query(
                    "SELECT poster_url FROM posters WHERE movie_id = ?",
                    [movie.id],
                    (err, posters) => {
                        if (err) reject(err);
                        else {
                            resolve({
                                ...movie,
                                posters: posters.map(p => p.poster_url)
                            });
                        }
                    }
                );
            });
        });

        Promise.all(promises)
            .then(result => res.json(result))
            .catch(err => res.json({ error: err }));
    });
});


// 🚀 Start server
app.listen(3000, () => {
    console.log("🚀 Server running on port 3000");
});
