// Sample CVs and a sample role so the workspace can be tried before real CVs are uploaded. Fictional people.
(function (root) {
  const cvs = [
    { fileName: "priya-nair-cv.txt", text: `PRIYA NAIR
Senior Data Engineer
Location: Manchester, UK
Email: priya.nair@example.com | Mobile: +44 7700 900123
linkedin.com/in/priya-nair-data

Profile
Senior data engineer with 8 years of experience building data pipelines on AWS and Azure.

Experience
Senior Data Engineer, Northwind Retail (2021 - present)
- Designed ETL and ELT pipelines in Spark, Airflow and dbt feeding Snowflake.
- Led data modelling (star schema) for finance reporting in Power BI.
- Introduced data quality checks and data governance standards.
Data Engineer, Contoso Bank (2017 - 2021)
- Python and SQL pipelines, Kafka streaming, CI/CD with GitHub Actions.
- Stakeholder management with finance and risk teams.

Skills
Python, SQL, Spark, Airflow, dbt, Kafka, Snowflake, AWS, Azure, Terraform, Power BI` },
    { fileName: "daniel-okafor-cv.txt", text: `Daniel Okafor
Full Stack Software Engineer
Address: Leeds, UK
daniel.okafor@example.com
07700 900456

Summary
Software engineer with 4 years experience in JavaScript, TypeScript, React and Node.js.

Experience
Software Engineer, BrightPath (2022 - present)
- Built React front ends and Node.js microservices; API design and testing with Jest and Cypress.
- Docker and Kubernetes deployment on AWS; CI/CD in GitHub Actions.
Junior Developer, Fabrikam (2020 - 2022)
- PHP and MySQL maintenance; user stories and backlog grooming with the product owner.` },
    { fileName: "sara-lindqvist-cv.txt", text: `Sara Lindqvist
Lead Business Analyst
Location: London
Email: sara.l@example.com  Phone: +44 20 7946 0958

12 years of experience in business analysis, requirements, process improvement (Lean, BPMN) and stakeholder engagement across banking change programmes.
Certified PRINCE2 practitioner; ran project delivery for a regulatory reporting programme.
Built Tableau dashboards for operations reporting.` },
  ];
  const role = {
    title: "Senior Data Engineer",
    client: "Acme Insurance",
    location: "Manchester (hybrid)",
    description: `Acme Insurance is hiring a Senior Data Engineer to build its cloud data platform.

Essential
- 6+ years in data engineering: Spark, Airflow, ETL/ELT pipelines
- Data modelling (dimensional, star schema)
- Python and SQL programming
- AWS cloud infrastructure

Desirable
- Power BI reporting
- Data governance and data quality`,
  };
  root.CapSamples = { cvs, role };
})(typeof window !== "undefined" ? window : globalThis);
