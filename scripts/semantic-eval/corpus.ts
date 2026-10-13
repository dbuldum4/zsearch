/**
 * A small home folder for `semantic-eval.ts`: the notes, letters and papers a person keeps, with
 * the noise around them that crowds semantic results (long handbooks and manuals, licences and
 * changelogs, a Lean project), and questions about it with the files that answer them.
 *
 * Relevance is graded: 2 is the file the question is after, 1 a file that is some help.
 */

const p = (...paras: string[]) => paras.join("\n\n") + "\n"

export const FILES: Record<string, string> = {
  /* ---------------------------------------------------------------- home -- */
  "Documents/home/plumber-visit.txt": p(
    "Plumber came on Tuesday about the kitchen sink.",
    "The pipe under the basin was cracked and dripping into the cabinet. He replaced the trap and the seal, and tightened the tap. Total was 180 euros, paid in cash.",
    "He said the bathroom shower drain is slow too and should be cleared before winter.",
  ),
  "Documents/home/roof-quote.md": p(
    "# Roof repair quote",
    "Kowalski Roofing inspected the house on 3 March. Several tiles on the north side are broken and the flashing around the chimney has come loose, which is why water came through the attic ceiling during the storm.",
    "Quote: 2,350 euros for new tiles, flashing and labour. Scaffolding is extra (400 euros). Work can start in April if the weather allows.",
  ),
  "Documents/home/lease-agreement.txt": p(
    "Residential lease agreement between Maria Lopes (landlord) and the tenant for the flat at Rua das Flores 12, third floor.",
    "The monthly rent is 950 euros, due on the first working day of each month by bank transfer. The deposit of two months' rent is returned within 30 days of the end of the tenancy, less the cost of any damage beyond normal wear.",
    "Either party may end the tenancy with two months' written notice. Pets are allowed with the landlord's written consent. The tenant is responsible for minor repairs; the landlord for the structure, the roof and the heating system.",
  ),
  "Documents/home/moving-checklist.md": p(
    "# Moving checklist",
    "- book the van for the 14th\n- pack the books and the kitchen first\n- forward the post to the new address\n- tell the bank, the doctor and the tax office the new address\n- read the electricity and water meters on the last day\n- return the keys to the landlord and ask for the deposit back",
  ),
  "Documents/home/wifi-setup.txt": p(
    "Home network",
    "The router is in the hallway cupboard. The mesh extender in the bedroom needs to be restarted when the connection drops. Guest network is separate from the main one. The internet contract with the provider renews in September; the speed is 500 megabits.",
  ),
  "Documents/home/garden-plan.md": p(
    "# Garden plan",
    "Plant tomatoes and peppers in May once the frost is over. The raised bed by the fence gets the most sun. Water the seedlings every morning in summer, and add compost in autumn.",
    "Lavender and rosemary along the path; they need little water. Prune the apple tree in late winter.",
  ),
  "Documents/home/electricity-bill-2024-11.txt": p(
    "Electricity statement, November 2024",
    "Account 448812. Consumption 312 kWh. Amount due 87.40 euros, to be debited on 5 December. Your consumption is 12% higher than the same month last year.",
  ),
  "Documents/home/insurance-claim.txt": p(
    "Home insurance claim: water damage",
    "On the night of the storm water came through the attic ceiling and stained the bedroom wall. Photos attached. The claim covers repainting the bedroom and replacing the damaged carpet. Claim number HC-20931. The adjuster will visit next week.",
  ),

  /* ------------------------------------------------------------- health -- */
  "Documents/health/dentist.txt": p(
    "Dental clinic Sorriso",
    "Check-up and cleaning booked for 18 June at 9:30 with Dr. Almeida. A filling on the lower left molar needs replacing; that is a second appointment, about 45 minutes, with local anaesthetic.",
  ),
  "Documents/health/blood-test-results.txt": p(
    "Laboratory report",
    "Cholesterol total 212 mg/dL (slightly high). HDL 58, LDL 131. Glucose fasting 92. Vitamin D low at 18 ng/mL: the doctor recommends a supplement through the winter and a new test in three months.",
  ),
  "Documents/health/running-plan.md": p(
    "# Half marathon training",
    "Twelve weeks to race day. Three easy runs a week, one long run on Sunday that grows by a kilometre each week, and one session of intervals on the track. Rest on Mondays. Stretch after every run and replace the shoes at 600 km.",
  ),
  "Documents/health/vet-max.txt": p(
    "Max, golden retriever, 6 years",
    "Annual vaccinations done at the veterinary clinic. He has put on weight: less food, more walks. Next appointment for his teeth in October. Flea and tick treatment every month.",
  ),

  /* ------------------------------------------------------------- money -- */
  "Documents/money/tax-notes-2024.md": p(
    "# Tax return 2024",
    "Deductible: health expenses, the children's school fees, the rent receipts, and the donation to the food bank. The freelance income from the translation work goes in category B. Deadline for the return is 30 June; the refund usually arrives in August.",
  ),
  "Documents/money/budget-notes.txt": p(
    "Monthly budget",
    "Income after tax 3,100. Rent 950, groceries about 450, transport 90, phone and internet 55, savings 500 into the index fund. Eating out is the item that always goes over.",
  ),
  "Documents/money/invoice-translation-0042.txt": p(
    "INVOICE 0042",
    "Translation of the technical manual from German into Portuguese, 18,500 words at 0.08 per word. Total 1,480 euros. Payment within 30 days to the account below. Thank you for your business.",
  ),
  "Documents/money/car-loan.txt": p(
    "Car financing contract",
    "Loan of 12,000 euros over 48 months at 5.9% annual interest. Monthly instalment 281 euros. Early repayment is allowed with a fee of 0.5% of the amount repaid.",
  ),

  /* ---------------------------------------------------------------- car -- */
  "Documents/car/service-record.txt": p(
    "Service record, Golf 1.6 TDI",
    "At 90,000 km: oil and filter changed, front brake pads replaced, tyres rotated. The mechanic says the timing belt is due at 120,000 km and the rear tyres will need replacing before winter.",
  ),
  "Documents/car/parking-fine.txt": p(
    "Notice of penalty",
    "Vehicle registration 45-RT-88 was parked in a loading zone on 2 February at 11:14. Fine 60 euros if paid within 15 days. You may appeal in writing within the same period.",
  ),

  /* ------------------------------------------------------------- travel -- */
  "Documents/travel/japan-itinerary.md": p(
    "# Japan, April",
    "Day 1-4 Tokyo: Shinjuku hotel, Asakusa temple, the fish market early in the morning, a day trip to Nikko. Day 5-8 Kyoto: bamboo forest at Arashiyama, Fushimi Inari gates at sunrise, tea ceremony. Day 9 Nara deer park. Day 10 Osaka street food, fly home from Kansai.",
    "Rail pass for 7 days, activate it in Kyoto. Book the ryokan in Hakone if there is time.",
  ),
  "Documents/travel/lisbon-flights.txt": p(
    "Booking confirmation",
    "Flight TP 1351 Lisbon to London Heathrow, departing 07:05 on 22 May, seat 14C. Return 26 May. One checked bag included. Check in online 36 hours before departure.",
  ),
  "Documents/travel/passport-renewal.txt": p(
    "Passport renewal",
    "Bring the old passport, two photos and the form to the citizen shop. Renewal takes about two weeks, urgent service five days for an extra fee. The current passport expires in July, before the trip.",
  ),
  "Documents/travel/packing-list.md": p(
    "# Packing list for the mountains",
    "Hiking boots, rain jacket, warm layers, a headlamp, the first aid kit, sun cream and the water filter. Maps downloaded for offline use.",
  ),

  /* ------------------------------------------------------------- food -- */
  "Documents/recipes/sourdough.md": p(
    "# Sourdough bread",
    "Feed the starter the night before: equal weights of flour and water. In the morning mix 500 g strong flour, 350 g water, 100 g active starter and 10 g salt. Stretch and fold every half hour for two hours, shape, and leave in the fridge overnight. Bake in a hot cast iron pot, 20 minutes with the lid on and 25 with it off.",
  ),
  "Documents/recipes/lasagna.md": p(
    "# Grandma's lasagna",
    "Brown the minced beef with onion and garlic, add tomato passata and simmer for an hour. Make a béchamel with butter, flour and milk. Layer pasta sheets, meat sauce, béchamel and parmesan, four layers. Bake at 180 degrees for 40 minutes and rest for 10 before cutting.",
  ),
  "Documents/recipes/lentil-curry.txt": p(
    "Red lentil curry (vegan)",
    "Fry onion, ginger and garlic with cumin seeds, turmeric and chilli. Add the rinsed lentils, a tin of coconut milk and water, and simmer for 25 minutes until soft. Finish with lime juice and fresh coriander. Serves four, freezes well.",
  ),
  "Documents/recipes/pancakes.txt": p("Pancakes", "Mix flour, eggs, milk and a pinch of salt. Rest the batter for 20 minutes, then fry in butter until golden on both sides."),

  /* --------------------------------------------------------------- work -- */
  "Documents/work/cover-letter.txt": p(
    "Dear hiring team,",
    "I am applying for the position of data analyst. In my current role I build the monthly sales reports and automated the dashboards that the regional managers use, which cut the time to prepare them from three days to one hour.",
    "I would welcome the chance to discuss how my experience with SQL, Python and forecasting could help your team.",
  ),
  "Documents/work/resume.md": p(
    "# Ana Ribeiro",
    "Data analyst with six years of experience in retail. Skills: SQL, Python, Tableau, demand forecasting, A/B testing. Education: MSc in Statistics, University of Porto. Languages: Portuguese, English, German.",
  ),
  "Documents/work/meeting-2024-10-07.md": p(
    "# Q4 planning meeting",
    "Attendees: Ana, Tom, Priya. Decisions: the customer churn dashboard ships by the end of October; Tom owns the data pipeline migration; the budget for the new BI tool is approved up to 8,000 euros.",
    "Action items: Priya to interview the support team about why customers cancel; Ana to draft the churn model.",
  ),
  "Documents/work/performance-review.md": p(
    "# Annual review",
    "Strengths: reliable delivery, clear communication with stakeholders. To improve: delegate more, and present results to leadership with fewer slides. Goal for next year: lead the forecasting project. Salary increase of 4% from January.",
  ),
  "Documents/work/onboarding-notes.txt": p(
    "First week",
    "Laptop and badge from IT on Monday. Ask for access to the warehouse database and the reporting server. Lunch with the team on Wednesday. The manager's one-to-one is every second Thursday.",
  ),

  /* ----------------------------------------------------------- personal -- */
  "Documents/personal/wedding-speech.md": p(
    "# Best man speech for João and Sofia",
    "I met João on the first day of university, when he got lost looking for the library and found the bar instead. Sofia, thank you for making him the happiest I have ever seen him. Please raise your glasses to the bride and groom.",
  ),
  "Documents/personal/gift-ideas.txt": p("Gift ideas", "Mum: a cookbook and a plant for the balcony. Dad: the new biography of the cyclist he likes, or the birdwatching handbook he mentioned. Inês: concert tickets. Kids: a board game for rainy days."),
  "Documents/personal/books-to-read.md": p(
    "# Books to read",
    "- a history of the Roman empire\n- the novel about the lighthouse keeper that Rita lent me\n- something on habit building\n- the science fiction trilogy everyone recommends",
  ),
  "Documents/personal/journal-2024-08.md": p(
    "August",
    "Hiked in the Alps with Rita. The glacier was much smaller than when we came five years ago; climate change is plain to see up there. We slept in a hut at 2,800 metres and watched the sunrise over the peaks.",
  ),
  "Documents/personal/school-letter.txt": p(
    "Dear parents,",
    "The school trip to the science museum is on 12 May. Please return the signed permission slip and 15 euros by Friday. Children should bring a packed lunch. Parent-teacher meetings are in the week of 20 May.",
  ),

  /* -------------------------------------------------- papers and study -- */
  "Documents/study/thesis-draft.md": p(
    "# Predicting customer churn in subscription services",
    "This thesis compares logistic regression, gradient boosted trees and survival models for predicting which customers will cancel a subscription. Features include usage frequency, support tickets, tenure and price changes.",
    "Gradient boosting gave the best area under the curve, but survival models better answered when a customer is likely to leave, which matters more for retention campaigns.",
  ),
  "Documents/study/statistics-notes.md": p(
    "# Hypothesis testing",
    "The p-value is the probability of seeing data at least as extreme as observed if the null hypothesis were true. A confidence interval gives a range of plausible values for a parameter. With many comparisons, adjust the significance level (Bonferroni) to keep false positives down.",
    "Further reading: the Handbook of Statistics, volume 9, and the course slides from week 4.",
  ),

  /* ------------------------------------------------------- long noise -- */
  "Documents/work/employee-handbook.md": p(
    "# Employee handbook",
    "## Working hours\n\nThe standard working week is 40 hours. Core hours are 10:00 to 16:00; outside them employees may arrange their time with their manager. Overtime must be approved in advance.",
    "## Holidays\n\nEmployees receive 25 days of paid holiday a year, plus public holidays. Holiday requests go through the HR portal at least two weeks ahead. Up to five unused days may be carried over to the next year.",
    "## Sick leave\n\nTell your manager before 10:00 on the first day of absence. From the fourth day a doctor's note is required. Sick pay is the full salary for the first 30 days.",
    "## Expenses\n\nTravel, meals and accommodation on business trips are reimbursed against receipts submitted within 60 days. Economy class for flights under six hours. The daily meal allowance is 35 euros.",
    "## Equipment\n\nLaptops and phones remain company property and must be returned when employment ends. Report a lost or stolen device to IT immediately.",
    "## Security\n\nUse the password manager, lock your screen when away, and never share credentials. Suspicious emails go to the security team. Customer data must not leave the approved systems.",
    "## Remote work\n\nEmployees may work from home up to three days a week. The company pays a monthly allowance of 30 euros for internet and electricity.",
    "## Conduct\n\nTreat colleagues, customers and partners with respect. Harassment and discrimination are not tolerated. Conflicts of interest must be declared to HR.",
    "## Training\n\nEach employee has a yearly budget of 1,000 euros for courses, books and conferences, agreed with their manager.",
    "## Leaving the company\n\nThe notice period is one month in the first year and two months after. Unused holiday is paid out with the last salary.",
  ),
  "Documents/manuals/dishwasher-manual.txt": p(
    "Dishwasher user manual",
    "Safety: disconnect the appliance from the mains before cleaning or maintenance. Do not let children play with the appliance. Installation must be carried out by a qualified person in accordance with local regulations.",
    "Loading: place cups and glasses in the upper basket, plates and pans in the lower basket. Make sure the spray arms can turn freely.",
    "Programmes: Eco 50 degrees for normally soiled dishes, Intensive 70 degrees for pans, Quick 30 minutes for lightly soiled loads.",
    "Troubleshooting: if water remains in the bottom of the appliance, clean the filter and check that the drain hose is not kinked. If the dishes are not clean, use more detergent and check the spray arms for blockages. Error E24 means the drain pump is blocked.",
    "Maintenance: clean the filter every week and run an empty hot cycle with descaler every month. Refill the rinse aid and the salt when the indicators light up.",
    "Warranty: two years from the date of purchase. Keep the receipt. The warranty does not cover damage from incorrect installation or use.",
  ),
  "Documents/manuals/router-manual.txt": p(
    "Wireless router quick start guide",
    "Connect the router to the modem with the supplied network cable and power it on. Wait until the status light turns steady. Connect to the network name printed on the label and open the configuration page in a browser.",
    "Change the administrator password on first use. Choose WPA3 security for the wireless network. Firmware updates are installed automatically at night.",
    "If the connection drops, restart the router and the modem. Reset to factory settings by holding the reset button for ten seconds.",
  ),

  /* -------------------------------------------------- licences and code -- */
  "Projects/webapp/LICENSE": p(
    "MIT License",
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY.",
  ),
  "Projects/webapp/CHANGELOG.md": p(
    "# Changelog",
    "## 2.3.0\n\n- Add export of reports to CSV\n- Fix the login page on small screens\n- Update dependencies",
    "## 2.2.1\n\n- Fix a crash when the cache is empty\n- Improve the error message when the database is unreachable",
    "## 2.2.0\n\n- New dashboard for monthly sales\n- Faster loading of the customer list",
  ),
  "Projects/webapp/README.md": p(
    "# Sales dashboard",
    "A small web app that shows the monthly sales reports from the warehouse database. Run `npm install` and `npm start`, then open the browser at port 3000. Configuration is read from the environment.",
  ),

  /* ----------------------------------------------- a Lean project -- */
  "Projects/proofs/Analysis/Continuity.lean": p(
    "import Mathlib.Topology.Basic",
    "/-- A function is continuous at a point when small changes in the input give small changes in the output. -/\ntheorem continuous_comp {f g : ℝ → ℝ} (hf : Continuous f) (hg : Continuous g) : Continuous (g ∘ f) := by\n  exact hg.comp hf",
    "/-- The sum of two continuous functions is continuous. -/\ntheorem continuous_add' (hf : Continuous f) (hg : Continuous g) : Continuous (fun x => f x + g x) := by\n  exact hf.add hg",
  ),
  "Projects/proofs/Probability/Expectation.lean": p(
    "import Mathlib.Probability.Notation",
    "/-- The expected value of a random variable, the average of its values weighted by probability. The cost of a test is its expected loss. -/\ntheorem expectation_add (X Y : Ω → ℝ) : 𝔼[X + Y] = 𝔼[X] + 𝔼[Y] := by\n  simp [integral_add]",
    "/-- Markov's inequality bounds the probability that a nonnegative random variable exceeds a value by its expectation divided by that value. -/\ntheorem markov (X : Ω → ℝ) (a : ℝ) (ha : 0 < a) : P {ω | a ≤ X ω} ≤ 𝔼[X] / a := by\n  sorry",
  ),
  "Projects/proofs/Algebra/Groups.lean": p(
    "import Mathlib.Algebra.Group.Basic",
    "/-- In a group every element has a unique inverse; the payment of a debt is its inverse in the ledger group. -/\ntheorem inv_unique {G : Type} [Group G] (a b : G) (h : a * b = 1) : b = a⁻¹ := by\n  exact eq_inv_of_mul_eq_one_right h",
    "/-- The order of a subgroup divides the order of the group (Lagrange). Moving between cosets keeps their size. -/\ntheorem lagrange {G : Type} [Group G] [Fintype G] (H : Subgroup G) : Fintype.card H ∣ Fintype.card G := by\n  exact Subgroup.card_subgroup_dvd_card H",
  ),
  "Projects/proofs/Basic/Travel.lean": p(
    "import Mathlib.Combinatorics.SimpleGraph.Basic",
    "/-- A trip through a graph visits vertices along edges; a journey that returns home is a cycle. The shortest route between two cities is a path of least weight. -/\ndef Walk.length {V : Type} (G : SimpleGraph V) : G.Walk u v → ℕ\n  | .nil => 0\n  | .cons _ p => p.length + 1",
    "/-- Every tree with n vertices has n - 1 edges, like a family tree with one parent link per child. -/\ntheorem tree_edges (T : SimpleGraph V) (hT : T.IsTree) : T.edgeFinset.card + 1 = Fintype.card V := by\n  sorry",
  ),
  "Projects/proofs/Basic/Food.lean": p(
    "import Mathlib.Order.Basic",
    "/-- A recipe as an ordered list of steps: bake after mixing, mixing after measuring flour and water. Ordering the steps is a linear extension of the partial order. -/\ndef Recipe := List Step",
    "/-- The kitchen schedule is a total order on tasks; cooking dinner for guests in time means finding a schedule that meets every deadline. -/\ntheorem schedule_exists (tasks : Finset Task) : ∃ s : List Task, s.Nodup := by\n  sorry",
  ),
}

export interface Question {
  q: string
  /** The files that answer it: 2 the one it is after, 1 some help. */
  relevant: Record<string, 1 | 2>
  /** "words": its words are in the files; "mixed": some are; "meaning": none or nearly none are. */
  type: "words" | "mixed" | "meaning"
}

export const QUESTIONS: Question[] = [
  // The words are in the file.
  { q: "plumber kitchen sink", type: "words", relevant: { "Documents/home/plumber-visit.txt": 2 } },
  { q: "roof repair quote", type: "words", relevant: { "Documents/home/roof-quote.md": 2, "Documents/home/insurance-claim.txt": 1 } },
  { q: "sourdough starter", type: "words", relevant: { "Documents/recipes/sourdough.md": 2 } },
  { q: "japan itinerary kyoto", type: "words", relevant: { "Documents/travel/japan-itinerary.md": 2 } },
  { q: "lease deposit", type: "words", relevant: { "Documents/home/lease-agreement.txt": 2, "Documents/home/moving-checklist.md": 1 } },
  { q: "dentist appointment", type: "words", relevant: { "Documents/health/dentist.txt": 2 } },
  { q: "churn dashboard", type: "words", relevant: { "Documents/work/meeting-2024-10-07.md": 2, "Documents/study/thesis-draft.md": 1 } },
  { q: "timing belt", type: "words", relevant: { "Documents/car/service-record.txt": 2 } },
  { q: "vitamin d supplement", type: "words", relevant: { "Documents/health/blood-test-results.txt": 2 } },
  { q: "permission slip museum", type: "words", relevant: { "Documents/personal/school-letter.txt": 2 } },
  { q: "handbook", type: "words", relevant: { "Documents/work/employee-handbook.md": 2 } },
  { q: "handbook type:markdown", type: "words", relevant: { "Documents/work/employee-handbook.md": 2 } },
  { q: "resume", type: "words", relevant: { "Documents/work/resume.md": 2, "Documents/work/cover-letter.txt": 1 } },
  // Some of the words are there.
  { q: "how much was the plumber", type: "mixed", relevant: { "Documents/home/plumber-visit.txt": 2 } },
  { q: "when does my passport expire", type: "mixed", relevant: { "Documents/travel/passport-renewal.txt": 2 } },
  { q: "what time is my flight to london", type: "mixed", relevant: { "Documents/travel/lisbon-flights.txt": 2 } },
  { q: "notice period to leave the flat", type: "mixed", relevant: { "Documents/home/lease-agreement.txt": 2 } },
  { q: "when is the tax deadline", type: "mixed", relevant: { "Documents/money/tax-notes-2024.md": 2 } },
  { q: "interest rate on the car loan", type: "mixed", relevant: { "Documents/money/car-loan.txt": 2 } },
  { q: "salary increase from my review", type: "mixed", relevant: { "Documents/work/performance-review.md": 2 } },
  { q: "dog vaccinations", type: "mixed", relevant: { "Documents/health/vet-max.txt": 2 } },
  { q: "how long to bake the bread", type: "mixed", relevant: { "Documents/recipes/sourdough.md": 2 } },
  { q: "water leak in the attic", type: "mixed", relevant: { "Documents/home/insurance-claim.txt": 2, "Documents/home/roof-quote.md": 2 } },
  // By meaning.
  { q: "fixing the leaking faucet", type: "meaning", relevant: { "Documents/home/plumber-visit.txt": 2 } },
  { q: "car maintenance", type: "meaning", relevant: { "Documents/car/service-record.txt": 2 } },
  { q: "vegetarian dinner ideas", type: "meaning", relevant: { "Documents/recipes/lentil-curry.txt": 2 } },
  { q: "cholesterol levels", type: "meaning", relevant: { "Documents/health/blood-test-results.txt": 2 } },
  { q: "job application", type: "meaning", relevant: { "Documents/work/cover-letter.txt": 2, "Documents/work/resume.md": 2 } },
  { q: "holiday in asia", type: "meaning", relevant: { "Documents/travel/japan-itinerary.md": 2 } },
  { q: "exercise routine", type: "meaning", relevant: { "Documents/health/running-plan.md": 2 } },
  { q: "monthly spending", type: "meaning", relevant: { "Documents/money/budget-notes.txt": 2, "Documents/home/electricity-bill-2024-11.txt": 1 } },
  { q: "growing vegetables", type: "meaning", relevant: { "Documents/home/garden-plan.md": 2 } },
  { q: "toast at a wedding", type: "meaning", relevant: { "Documents/personal/wedding-speech.md": 2 } },
  { q: "mountain hike", type: "meaning", relevant: { "Documents/personal/journal-2024-08.md": 2, "Documents/travel/packing-list.md": 2 } },
  { q: "traffic ticket", type: "meaning", relevant: { "Documents/car/parking-fine.txt": 2 } },
  { q: "statistical significance", type: "meaning", relevant: { "Documents/study/statistics-notes.md": 2 } },
  { q: "internet keeps disconnecting", type: "meaning", relevant: { "Documents/home/wifi-setup.txt": 2, "Documents/manuals/router-manual.txt": 2 } },
]
