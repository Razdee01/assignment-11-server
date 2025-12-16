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
      const paymentData = req.body;

      const session = await stripe.checkout.sessions.create({
        success_url: "https://example.com/success",
        line_items: [
          {
            price_data: {
              currency: "bdt",
              product_data: {
                name: paymentData.contestName,
                description: paymentData.description,
                images: [paymentData.bannerImage],
              },
              unit_amount: paymentData.amount * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentData.userEmail,
        mode: "payment",
        metadata: {
          contestId: paymentData.contestId,
          contestName: paymentData.contestName,
          bannerImage: paymentData.bannerImage, // ✅ ADD
          description: paymentData.description, // ✅ ADD
          userId: paymentData.userId,
          userName: paymentData.userName,
          userEmail: paymentData.userEmail,
          userPhoto: paymentData.userPhoto,
        },

        success_url:
          "http://localhost:5173/payment-success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: `http://localhost:5173/contests/${paymentData.contestId}`,
      });
      res.send({ url: session.url });
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
    app.get("/participates/:userEmail", async (req, res) => {
      const userEmail = req.params.userEmail;
      const registrations = await registrationsCollection
        .find({
          contestId,
        })
        .toArray();
      res.send(registrations);
    });
    // Backend: Add this route to your server (e.g., index.js or routes/contest.js)

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

       // ← Change this to your email for easy testing

        const newContest = {
          name,
          bannerImage: image,
          description,
          entryFee: Number(price),
          prizeMoney: Number(prizeMoney),
          taskDetails: taskInstruction,
          contentType: contestType,
          deadline: deadline, // already in ISO format
          creatorEmail, // ← Hardcoded for now
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

