# Markdown Writer for Web-based Retrieval Augmented Content Composer

From scrapped HTML, this worker generates markdown files containing a summary of the page in markdown format for retrieval augmented content composer.
To improve the quality of the markdown containing only relevant page content, the worker first preprocesses the HTML to remove unnecessary elements and then uses a LLM to generate the markdown.
