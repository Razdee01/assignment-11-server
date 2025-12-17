require("dotenv").config();

const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const cors = require("cors");
const app = express();
const port = 3000;
app.use(express.json());
app.use(cors());

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri =
  "mongodb+srv://contestHub-db:QBYR33eiAyOcD3Sp@cluster0.xujbby0.mongodb.net/?appName=Cluster0";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("contestHub-db");
    const contestsCollection = db.collection("contests");
    const registrationsCollection = db.collection("registrations");
    const submissionsCollection = db.collection("submissions");

    app.get("/popular-contests", async (req, res) => {
      try {
        const contests = await contestsCollection
          .find()
          .sort({
            participants: -1,
          })
          .limit(5)
          .toArray();

        res.send(contests);
      } catch (error) {
        res.status(500).send({ message: "Failed to load popular contests" });
      }
    });

    app.get("/all-contests", async (req, res) => {
      const { search } = req.query;
      let filter = {};

      if (search && search !== "All") {
        // Case-insensitive regex match
        filter.contentType = { $regex: `^${search}$`, $options: "i" };
      }

      try {
        const contests = await contestsCollection.find(filter).toArray();
        res.status(200).send(contests);
      } catch (err) {
        res.status(500).send({ message: "Error fetching contests" });
      }
    });

    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentData = req.body;

        // === NEW: Minimum amount check for BDT (Stripe requires ~50 US cents equivalent) ===
        if (paymentData.amount < 100) {
          return res.status(400).json({
            message:
              "Entry fee too low. Minimum ৳100 required for Stripe payment.",
          });
        }

        // === Optional: Validate bannerImage (prevents crashes if invalid) ===
        let images = [];
        if (
          typeof paymentData.bannerImage === "string" &&
          paymentData.bannerImage.startsWith("https://")
        ) {
          images = [paymentData.bannerImage];
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          customer_email: paymentData.userEmail,
          mode: "payment",
          line_items: [
            {
              price_data: {
                currency: "bdt",
                product_data: {
                  name: paymentData.contestName,
                  description: paymentData.description,
                  images: images, // safe — empty if invalid
                },
                unit_amount: Math.round(paymentData.amount * 100), // safe rounding
              },
              quantity: 1,
            },
          ],
          metadata: {
            contestId: paymentData.contestId,
            contestName: paymentData.contestName,
            bannerImage: paymentData.bannerImage || "",
            description: paymentData.description,
            userId: paymentData.userId,
            userName: paymentData.userName,
            userEmail: paymentData.userEmail,
            userPhoto: paymentData.userPhoto || "",
            creatorEmail: paymentData.userEmail, // temporary
          },
          success_url:
            "http://localhost:5173/payment-success?session_id={CHECKOUT_SESSION_ID}",
          cancel_url: `http://localhost:5173/contests/${paymentData.contestId}`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).json({
          message: "Failed to create checkout session",
          error: error.message,
        });
      }
    });
    // GET /winning-contests/:userEmail
    // Returns contests where this user is the winner
    app.get("/winning-contests/:userEmail", async (req, res) => {
      try {
        const userEmail = req.params.userEmail;

        const winningContests = await contestsCollection
          .find({ "winner.email": userEmail }) // matches winner.email
          .sort({ deadline: -1 }) // newest first
          .toArray();

        console.log(`Found ${winningContests.length} wins for ${userEmail}`);

        res.json(winningContests);
      } catch (error) {
        console.error("Error fetching winning contests:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;

      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const contest = await contestsCollection.findOne({
        _id: new ObjectId(session.metadata.contestId),
      });
      const registration = await registrationsCollection.findOne({
        transactionId: session.payment_intent,
      });

      if (session.payment_status === "paid" && contest && !registration) {
        const registrationInfo = {
          contestId: session.metadata.contestId,
          contestName: session.metadata.contestName,
          bannerImage: session.metadata.bannerImage,
          status: "pending",
          description: session.metadata.description,
          amount: session.amount_total / 100,
          userId: session.metadata.userId,
          userName: session.metadata.userName,
          userEmail: session.metadata.userEmail,
          userPhoto: session.metadata.userPhoto,
          transactionId: session.payment_intent,
        };

        const result = await registrationsCollection.insertOne(
          registrationInfo
        );
        await contestsCollection.updateOne(
          { _id: new ObjectId(session.metadata.contestId) },
          { $inc: { participants: 1 } }
        );
        return res.send({
          transactionId: session.payment_intent,
          registrationId: result.insertedId,
        });
      }

      res.send(
        res.send({
          transactionId: session.payment_intent,
          contestId: contest._id,
        })
      );
    });

    app.get("/registrations/check", async (req, res) => {
      const { contestId, email } = req.query;

      const registration = await registrationsCollection.findOne({
        userEmail: email,
        $or: [{ contestId: contestId }, { contestId: new ObjectId(contestId) }],
      });

      res.send({ registered: !!registration });
    });
    app.post("/submit-task", async (req, res) => {
      try {
        const { contestId, taskLink, userEmail } = req.body;

        if (!contestId || !taskLink || !userEmail) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        // 1️⃣ Check registration
        const registration = await registrationsCollection.findOne({
          userEmail,
          $or: [{ contestId }, { contestId: new ObjectId(contestId) }],
        });

        if (!registration) {
          return res.status(403).send({ message: "User not registered" });
        }

        // 2️⃣ Prevent duplicate submission
        const existingSubmission = await submissionsCollection.findOne({
          userEmail,
          $or: [{ contestId }, { contestId: new ObjectId(contestId) }],
        });

        if (existingSubmission) {
          return res.status(409).send({ message: "Already submitted" });
        }

        // 3️⃣ Save submission
        const submission = {
          contestId,
          userEmail,
          taskLink,
          status: "submitted",
          submittedAt: new Date(),
        };

        await submissionsCollection.insertOne(submission);

        res.send({ message: "Submission successful" });
      } catch (error) {
        console.error("SUBMIT ERROR:", error);
        res.status(500).send({ error: error.message });
      }
    });
    app.get("/submissions/check", async (req, res) => {
      const { contestId, email } = req.query;

      const submission = await submissionsCollection.findOne({
        userEmail: email,
        $or: [{ contestId }, { contestId: new ObjectId(contestId) }],
      });

      res.send({ submitted: !!submission });
    });
    app.get("/registrations/:userEmail", async (req, res) => {
      const userEmail = req.params.userEmail;
      const registrations = await registrationsCollection
        .find({ userEmail })
        .toArray();
      res.send(registrations);
    });

    app.get("/participates/:creatorEmail", async (req, res) => {
      try {
        const creatorEmail = req.params.creatorEmail;

        const creatorContests = await contestsCollection
          .find({ creatorEmail })
          .toArray();

        const contestIds = creatorContests.map((c) => c._id.toString());

        const participants = await registrationsCollection
          .find({ contestId: { $in: contestIds } })
          .toArray();

        // Enrich with contest name
        const enriched = participants.map((p) => {
          const contest = creatorContests.find(
            (c) => c._id.toString() === p.contestId
          );
          return {
            ...p,
            contestName: contest ? contest.name : "Unknown Contest",
          };
        });

        res.json(enriched);
      } catch (error) {
        console.error("Error fetching participants:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.post("/api/contests", async (req, res) => {
      try {
        console.log("=== Create Contest Request (No Auth) ===");
        console.log("req.body:", req.body);

        const {
          name,
          image,
          description,
          price,
          prizeMoney,
          taskInstruction,
          contestType,
          deadline,
          creatorEmail,
        } = req.body;

        const newContest = {
          name,
          bannerImage: image,
          description,
          entryFee: Number(price),
          prizeMoney: Number(prizeMoney),
          taskDetails: taskInstruction,
          contentType: contestType,
          deadline: deadline, // already in ISO format
          creatorEmail,
          status: "pending",
          participants: 0,
        };

        console.log("Inserting:", newContest);

        const result = await contestsCollection.insertOne(newContest);

        console.log("Success! Contest ID:", result.insertedId);

        res.status(201).json({
          success: true,
          message:
            "Contest created successfully! (Test mode - no login required)",
          contestId: result.insertedId,
        });
      } catch (error) {
        console.error("ERROR:", error);
        res.status(500).json({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });
    // -----
    // POST /api/contests/declare-winner
    // Only the creator can call this (you can add auth later)
    // POST /api/contests/declare-winner
    app.post("/api/contests/declare-winner", async (req, res) => {
      try {
        const { contestId, winnerName, winnerEmail, winnerPhoto } = req.body;

        if (!contestId || !winnerName || !winnerEmail) {
          return res.status(400).json({ message: "Missing winner info" });
        }

        const result = await contestsCollection.updateOne(
          { _id: new ObjectId(contestId) },
          {
            $set: {
              winner: {
                name: winnerName,
                email: winnerEmail,
                photo: winnerPhoto || "",
              },
              winnerDeclaredAt: new Date(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Contest not found" });
        }

        res.json({ success: true, message: "Winner declared! 🏆" });
      } catch (error) {
        console.error("Error declaring winner:", error);
        res.status(500).json({ message: "Server error" });
      }
    });
    // GET /my-contests/:creatorEmail
    // GET /participated-contests/:userEmail
    // Returns full contest details for contests the user has paid/registered for
    app.get("/participated-contests/:userEmail", async (req, res) => {
      try {
        const userEmail = req.params.userEmail;

        // Find all registrations for this user
        const registrations = await registrationsCollection
          .find({ userEmail })
          .toArray();

        if (registrations.length === 0) {
          return res.json([]);
        }

        // Extract contest IDs (as strings)
        const contestIds = registrations.map((reg) => reg.contestId.toString());

        // Find full contest details
        const contests = await contestsCollection
          .find({ _id: { $in: contestIds.map((id) => new ObjectId(id)) } })
          .toArray();

        // Sort by deadline (earliest/upcoming first)
        contests.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

        res.json(contests);
      } catch (error) {
        console.error("Error fetching participated contests:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.get("/my-contests/:creatorEmail", async (req, res) => {
      try {
        const creatorEmail = req.params.creatorEmail;

        const contests = await contestsCollection
          .find({ creatorEmail })
          .sort({ createdAt: -1 }) // newest first
          .toArray();

        res.json(contests);
      } catch (error) {
        console.error("Error fetching my contests:", error);
        res.status(500).json({ message: "Server error" });
      }
    });
    app.get("/contests/:id", async (req, res) => {
      const id = req.params.id;
      const contest = await contestsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(contest);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
