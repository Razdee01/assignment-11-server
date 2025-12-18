require("dotenv").config();
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = 3000;
app.use(express.json());
app.use(cors());

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
    const usersCollection = db.collection("users");

    // ================= POPULAR CONTESTS =================
    app.get("/popular-contests", async (req, res) => {
      try {
        const contests = await contestsCollection
          .find()
          .sort({ participants: -1 })
          .limit(5)
          .toArray();
        res.send(contests);
      } catch (error) {
        res.status(500).send({ message: "Failed to load popular contests" });
      }
    });

    // ================= ALL CONTESTS =================
    app.get("/all-contests", async (req, res) => {
      const { search } = req.query;
      let filter = {status: "Confirmed"};
      if (search && search !== "All") {
        filter.contentType = { $regex: `^${search}$`, $options: "i" };
      }
      try {
        const contests = await contestsCollection.find(filter).toArray();
        res.status(200).send(contests);
      } catch (err) {
        res.status(500).send({ message: "Error fetching contests" });
      }
    });

    // ================= STRIPE CHECKOUT =================
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const paymentData = req.body;
        if (paymentData.amount < 100)
          return res
            .status(400)
            .json({ message: "Entry fee too low. Minimum ৳100 required." });

        const images = paymentData.bannerImage?.startsWith("https://")
          ? [paymentData.bannerImage]
          : [];

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
                  images: images,
                },
                unit_amount: Math.round(paymentData.amount * 100),
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
            creatorEmail: paymentData.userEmail,
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

    // ================= PAYMENT SUCCESS =================
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
          contestId: session.metadata.contestId, // **string**
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

      res.send({
        transactionId: session.payment_intent,
        contestId: contest?._id,
      });
    });

    // ================= REGISTER =================
    app.post("/register", async (req, res) => {
      try {
        const { contestId, userEmail, userName, userPhoto } = req.body;
        const contest = await contestsCollection.findOne({
          _id: new ObjectId(contestId),
        });

        if (!contest)
          return res.status(404).json({ message: "Contest not found" });

        // DEADLINE CHECK
        if (new Date() > new Date(contest.deadline))
          return res.status(400).json({ message: "Contest has ended" });

        // WINNER DECLARED CHECK
        if (contest.winner)
          return res.status(400).json({ message: "Winner already declared" });

        const existingRegistration = await registrationsCollection.findOne({
          contestId,
          userEmail,
        });
        if (existingRegistration)
          return res.status(400).json({ message: "Already registered" });

        // Insert registration
        await registrationsCollection.insertOne({
          contestId, // string
          userEmail,
          userName,
          userPhoto,
          createdAt: new Date(),
        });

        // Increment contest participants
        await contestsCollection.updateOne(
          { _id: new ObjectId(contestId) },
          { $inc: { participants: 1 } }
        );

        // Add to users collection if not exists
        const existingUser = await usersCollection.findOne({
          email: userEmail,
        });
        if (!existingUser) {
          await usersCollection.insertOne({
            name: userName,
            email: userEmail,
            photo: userPhoto || "",
            role: "User",
            createdAt: new Date(),
          });
        }

        res.json({ success: true, message: "Registered successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ================= CHECK REGISTRATION =================
    app.get("/registrations/check", async (req, res) => {
      try {
        const { contestId, email } = req.query;
        const registration = await registrationsCollection.findOne({
          contestId,
          userEmail: email,
        });
        res.json({ registered: !!registration });
      } catch (err) {
        res.status(500).json({ message: "Server error" });
      }
    });

    // ================= SUBMIT TASK =================
  app.post("/submit-task", async (req, res) => {
    try {
      const { contestId, userEmail, taskLink } = req.body;

      // Get registration to pull name/photo
      const reg = await registrationsCollection.findOne({
        contestId,
        userEmail,
      });

      if (!reg) {
        return res
          .status(400)
          .json({ message: "Not registered for this contest" });
      }

      const existing = await submissionsCollection.findOne({
        contestId,
        userEmail,
      });
      if (existing) {
        return res.status(400).json({ message: "Already submitted" });
      }

      await submissionsCollection.insertOne({
        contestId,
        userEmail,
        taskLink,
        userName: reg.userName || "Unknown",
        userPhoto: reg.userPhoto || "",
        submittedAt: new Date(),
      });

      res.json({ success: true, message: "Submitted!" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  });
    // Update contest by ID
    app.patch("/api/contests/:id", async (req, res) => {
      try {
        const contestId = req.params.id;
        const updateData = req.body;

        const contest = await contestsCollection.findOne({
          _id: new ObjectId(contestId),
        });

        if (!contest)
          return res.status(404).json({ message: "Contest not found" });

        if (contest.status !== "Pending")
          return res
            .status(400)
            .json({ message: "Only pending contests can be edited" });

        await contestsCollection.updateOne(
          { _id: new ObjectId(contestId) },
          { $set: { ...updateData } }
        );

        res.json({ success: true, message: "Contest updated successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.delete("/creator/contests/:id", async (req, res) => {
      try {
        const contestId = req.params.id;
        const contest = await contestsCollection.findOne({
          _id: new ObjectId(contestId),
        });
        if (!contest)
          return res.status(404).json({ message: "Contest not found" });

        if (contest.status !== "Pending")
          return res
            .status(400)
            .json({ message: "Only pending contests can be deleted" });

        await contestsCollection.deleteOne({ _id: new ObjectId(contestId) });
        res.json({ success: true, message: "Contest deleted successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ================= CHECK SUBMISSION =================
    app.get("/submissions/check", async (req, res) => {
      try {
        const { contestId, email } = req.query;
        const submission = await submissionsCollection.findOne({
          contestId,
          userEmail: email,
        });
        res.json({ submitted: !!submission });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ================= CREATE CONTEST =================
   app.post("/api/contests", async (req, res) => {
     try {
       const {
         name,
         image,
         description,
         price, // from form
         prizeMoney,
         taskInstruction,
         contestType,
         deadline,
         creatorEmail,
       } = req.body;

       // Validate required fields
       if (
         !name ||
         !image ||
         !description ||
         !prizeMoney ||
         !taskInstruction ||
         !contestType ||
         !deadline ||
         !creatorEmail
       ) {
         return res.status(400).json({ message: "All fields are required" });
       }

       // Validate and convert price — prevent NaN
       const entryFee = Number(price);
       if (isNaN(entryFee) || entryFee < 100) {
         return res
           .status(400)
           .json({ message: "Entry fee must be a number ≥ ৳100" });
       }

       const newContest = {
         name,
         bannerImage: image,
         description,
         entryFee: entryFee, // safe number
         prizeMoney: Number(prizeMoney),
         taskDetails: taskInstruction,
         contentType: contestType,
         deadline: new Date(deadline),
         creatorEmail,
         status: "Pending",
         participants: 0,
         createdAt: new Date(),
       };

       const result = await contestsCollection.insertOne(newContest);
       res.json({ success: true, contestId: result.insertedId });
     } catch (err) {
       console.error(err);
       res.status(500).json({ message: "Failed to create contest" });
     }
   });
    // ================= DECLARE WINNER =================
    app.post("/api/contests/declare-winner", async (req, res) => {
      try {
        const { contestId, winnerName, winnerEmail, winnerPhoto } = req.body;
        if (!contestId || !winnerName || !winnerEmail)
          return res.status(400).json({ message: "Missing winner info" });

        const contest = await contestsCollection.findOne({
          _id: new ObjectId(contestId),
        });
        if (!contest)
          return res.status(404).json({ message: "Contest not found" });

        if (contest.winner)
          return res.status(400).json({ message: "Winner already declared" });

        await contestsCollection.updateOne(
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

        res.json({ success: true, message: "Winner declared! 🏆" });
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ================= GET PARTICIPANTS =================
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
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });

    /* ================= WINNING CONTESTS ================= */
    app.get("/winning-contests/:userEmail", async (req, res) => {
      try {
        const userEmail = req.params.userEmail;

        // Find contests where this user is the winner
        const winningContests = await contestsCollection
          .find({ "winner.email": userEmail })
          .sort({ deadline: -1 }) // latest first
          .toArray();

        res.json(winningContests);
      } catch (error) {
        console.error("Failed to load winning contests:", error);
        res.status(500).json({ message: "Server error" });
      }
    });
    /* ================= PARTICIPATED CONTESTS ================= */
    app.get("/participated-contests/:userEmail", async (req, res) => {
      try {
        const userEmail = req.params.userEmail;

        // Step 1: Find all registrations for this user
        const registrations = await registrationsCollection
          .find({ userEmail })
          .toArray();

        if (registrations.length === 0) {
          return res.json([]);
        }

        // Step 2: Fetch all contests
        const contests = await contestsCollection.find().toArray();

        // Step 3: Combine registration info with contest info
        const fullData = contests
          .filter((contest) =>
            registrations.some(
              (reg) => reg.contestId === contest._id.toString()
            )
          )
          .map((contest) => {
            const reg = registrations.find(
              (reg) => reg.contestId === contest._id.toString()
            );
            return {
              _id: contest._id,
              name: contest.name,
              entryFee: contest.entryFee,
              prizeMoney: contest.prizeMoney,
              deadline: contest.deadline,
              participants: contest.participants,
              paymentStatus: reg ? "Paid" : "Pending",
              contestEnded: new Date() > new Date(contest.deadline),
            };
          });

        // Step 4: Sort by deadline (soonest first)
        fullData.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

        res.json(fullData);
      } catch (err) {
        console.error("Failed to fetch participated contests:", err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ================= GET CONTEST DETAILS =================
    app.get("/contests/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const contest = await contestsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!contest)
          return res.status(404).json({ message: "Contest not found" });
        res.json(contest);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ================= GET MY CONTESTS =================
    app.get("/my-contests/:creatorEmail", async (req, res) => {
      try {
        const creatorEmail = req.params.creatorEmail;
        const contests = await contestsCollection
          .find({ creatorEmail })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(contests);
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    });
    // app.post("/contests", async (req, res) => {
    //   try {
    //     const {
    //       name,
    //       image,
    //       description,
    //       price,
    //       prizeMoney,
    //       taskInstruction,
    //       contestType,
    //       deadline,
    //       creatorEmail,
    //     } = req.body;

    //     if (!creatorEmail) {
    //       return res.status(400).json({ message: "Creator email required" });
    //     }

    //     const result = await contestsCollection.insertOne({
    //       name,
    //       bannerImage: image,
    //       description,
    //       entryFee: price,
    //       prizeMoney,
    //       taskInstruction,
    //       contestType,
    //       deadline,
    //       creatorEmail,
    //       status: "Pending",
    //       participants: 0,
    //       createdAt: new Date(),
    //     });

    //     res.json({ success: true, contestId: result.insertedId });
    //   } catch (err) {
    //     console.error(err);
    //     res.status(500).json({ message: "Server error" });
    //   }
    // });

    // GET all submissions for a specific contest
 app.get("/see-submissions/:contestId", async (req, res) => {
   try {
     const contestId = req.params.contestId;

     // Show all registered users (paid), not just submitted
     const registrations = await registrationsCollection
       .find({ contestId })
       .toArray();

     console.log("Found registrations:", registrations.length);

     const enriched = registrations.map((reg) => ({
       contestId,
       userName: reg.userName || "Unknown",
       userEmail: reg.userEmail,
       userPhoto: reg.userPhoto || "",
       taskLink: null, // no submission yet
       submitted: false,
     }));

     res.json(enriched);
   } catch (error) {
     console.error(error);
     res.status(500).json({ message: "Server error" });
   }
 });
    // ================= Admin =================
    // ================= GET ALL USERS =================
    app.get("/admin/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.json(users);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch users" });
      }
    });

    // ================= UPDATE USER ROLE =================
    app.patch("/admin/users/:id/role", async (req, res) => {
      try {
        const userId = req.params.id;
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { role } }
        );

        if (result.modifiedCount === 1) {
          res.json({ success: true, message: `Role updated to ${role}` });
        } else {
          res.status(404).json({ message: "User not found" });
        }
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to update role" });
      }
    });

    // ================= GET ALL CONTESTS =================
    app.get("/admin/contests", async (req, res) => {
      try {
        const contests = await contestsCollection.find().toArray();
        res.json(contests);
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to fetch contests" });
      }
    });

    // ================= UPDATE CONTEST STATUS =================
    app.patch("/admin/contests/:id/status", async (req, res) => {
      try {
        const contestId = req.params.id;
        const { status } = req.body; // "Confirmed" or "Rejected"

        const result = await contestsCollection.updateOne(
          { _id: new ObjectId(contestId) },
          { $set: { status } }
        );

        if (result.modifiedCount === 1) {
          res.json({
            success: true,
            message: `Contest ${status.toLowerCase()}`,
          });
        } else {
          res.status(404).json({ message: "Contest not found" });
        }
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to update contest status" });
      }
    });
    app.post("/save-user", async (req, res) => {
      try {
        const { uid, name, email, photo } = req.body;
        if (!email) return res.status(400).json({ message: "Email required" });

        const existing = await usersCollection.findOne({ email });
        if (existing) {
          await usersCollection.updateOne(
            { email },
            { $set: { name, photo, uid } }
          );
        } else {
          await usersCollection.insertOne({
            uid,
            name: name || "Unknown",
            email,
            photo: photo || "",
            role: "User",
            createdAt: new Date(),
          });
        }
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ message: "Server error" });
      }
    });
    app.get("/user-role/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const userDoc = await usersCollection.findOne({ email });
        res.json({ role: userDoc?.role || "User" });
      } catch (err) {
        res.status(500).json({ role: "User" });
      }
    });

    // ================= DELETE CONTEST =================
    app.delete("/admin/contests/:id", async (req, res) => {
      try {
        const contestId = req.params.id;
        const result = await contestsCollection.deleteOne({
          _id: new ObjectId(contestId),
        });

        if (result.deletedCount === 1) {
          res.json({ success: true, message: "Contest deleted permanently" });
        } else {
          res.status(404).json({ message: "Contest not found" });
        }
      } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Failed to delete contest" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Connected to MongoDB!");
  } finally {
    // client stays connected
  }
}

run().catch(console.dir);

app.get("/", (req, res) => res.send("Hello World!"));
app.listen(port, () => console.log(`Server running on port ${port}`));
