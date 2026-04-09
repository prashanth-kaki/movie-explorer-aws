const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ✅ RDS Connection Pool
const db = mysql.createPool({
    host: 'moviedb.cmpmaac422xa.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'prashu264',
    database: 'moviedb',
    waitForConnections: true,
    connectionLimit: 10
});

// ✅ AWS S3 Configuration (uses IAM Role on EC2)
const s3 = new S3Client({ region: 'us-east-1' });

const BUCKET_NAME = 'movie-posters-bucket-aws';
const OMDB_API_KEY = 'aefa5fe4'; // Replace with your valid key

// ✅ Upload poster to S3
async function uploadPosterToS3(posterUrl, title) {
    const response = await axios.get(posterUrl, {
        responseType: 'arraybuffer'
    });

    const fileName = `${title.replace(/\s+/g, '_')}_${Date.now()}.jpg`;

    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: response.data,
        ContentType: 'image/jpeg'
    }));

    return `https://${BUCKET_NAME}.s3.us-east-1.amazonaws.com/${fileName}`;
}

// 🎬 Movie Search Endpoint
app.get('/movie', async (req, res) => {
    const name = req.query.name;

    if (!name) {
        return res.status(400).json({ message: "Please provide movie name" });
    }

    try {
        // 1️⃣ Check if movie exists in RDS
        const [movieRows] = await db.promise().query(
            "SELECT * FROM movies WHERE LOWER(title) LIKE LOWER(?) LIMIT 1",
            [`%${name}%`]
        );

        if (movieRows.length > 0) {
            const movie = movieRows[0];

            const [posterRows] = await db.promise().query(
                "SELECT poster_url FROM posters WHERE movie_id = ? LIMIT 4",
                [movie.id]
            );

            return res.json({
                id: movie.id,
                title: movie.title,
                description: movie.description,
                release_year: movie.release_year,
                rating: movie.rating,
                director: movie.director,
                cast: movie.cast,
                genre: movie.genre,
                duration: movie.duration,
                posters: posterRows.map(p => p.poster_url)
            });
        }

        // 2️⃣ Try exact title search from OMDb
        let apiResponse = await axios.get(
            `http://www.omdbapi.com/?t=${encodeURIComponent(name)}&apikey=${OMDB_API_KEY}`
        );

        let data = apiResponse.data;

        // 3️⃣ If exact match fails, perform a broader search
        if (data.Response === "False") {
            const searchResponse = await axios.get(
                `http://www.omdbapi.com/?s=${encodeURIComponent(name)}&apikey=${OMDB_API_KEY}`
            );

            if (searchResponse.data.Response === "True") {
                const imdbID = searchResponse.data.Search[0].imdbID;

                const detailResponse = await axios.get(
                    `http://www.omdbapi.com/?i=${imdbID}&apikey=${OMDB_API_KEY}`
                );

                data = detailResponse.data;
            } else {
                return res.status(404).json({ message: "Movie not found" });
            }
        }

        // 4️⃣ Upload poster to S3
        let s3PosterUrl = null;
        if (data.Poster && data.Poster !== "N/A") {
            s3PosterUrl = await uploadPosterToS3(data.Poster, data.Title);
        }

        // 5️⃣ Insert movie into database
        const [insertResult] = await db.promise().query(
            `INSERT INTO movies 
            (title, description, release_year, rating, director, \`cast\`, genre, duration)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.Title,
                data.Plot,
                data.Year,
                data.imdbRating,
                data.Director,
                data.Actors,
                data.Genre,
                data.Runtime
            ]
        );

        const movieId = insertResult.insertId;

        // 6️⃣ Insert poster URL into posters table
        if (s3PosterUrl) {
            await db.promise().query(
                "INSERT INTO posters (movie_id, poster_url) VALUES (?, ?)",
                [movieId, s3PosterUrl]
            );
        }

        // 7️⃣ Send response
        res.status(201).json({
            id: movieId,
            title: data.Title,
            description: data.Plot,
            release_year: data.Year,
            rating: data.imdbRating,
            director: data.Director,
            cast: data.Actors,
            genre: data.Genre,
            duration: data.Runtime,
            posters: s3PosterUrl ? [s3PosterUrl] : []
        });

    } catch (error) {
        console.error("Detailed Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Internal server error" });
    }
});

// 🚀 Start Server
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
