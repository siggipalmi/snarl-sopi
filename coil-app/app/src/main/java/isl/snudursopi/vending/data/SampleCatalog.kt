package isl.snudursopi.vending.data

import isl.snudursopi.vending.domain.Category
import isl.snudursopi.vending.domain.Product

/**
 * Sample catalog used until we wire up the live Weimi API.
 * Real Icelandic products from the live machine photo for realism.
 */
object SampleCatalog {

    val products: List<Product> = listOf(
        Product(id = "isey-skyr", slot = "A1", name = "ísey skyr",
            subtitle = "jarðarber, 200g", priceIsk = 349,
            category = Category.Drinks, stock = 8, displayOrder = 10, featured = true),

        Product(id = "happy-hydra-lemon", slot = "A2", name = "happy hydra lemon",
            subtitle = "rafvökvi, 12g", priceIsk = 399,
            category = Category.Healthy, stock = 6, displayOrder = 20),

        Product(id = "happy-hydra-ginger", slot = "A3", name = "happy hydra ginger",
            subtitle = "rafvökvi, 12g", priceIsk = 399,
            category = Category.Healthy, stock = 5, displayOrder = 30),

        Product(id = "happy-hydra-berry", slot = "A4", name = "happy hydra berry",
            subtitle = "rafvökvi, 12g", priceIsk = 399,
            category = Category.Healthy, stock = 6, displayOrder = 40),

        Product(id = "corny-brown", slot = "A21", name = "corny big brown",
            subtitle = "múslístykki, 50g", priceIsk = 299,
            category = Category.Snacks, stock = 7, displayOrder = 50),

        Product(id = "corny-chocolate", slot = "A22", name = "corny big súkkulaði",
            subtitle = "múslístykki, 50g", priceIsk = 299,
            category = Category.Sweet, stock = 8, displayOrder = 60),

        Product(id = "corny-coconut", slot = "A23", name = "corny big coconut",
            subtitle = "múslístykki, 50g", priceIsk = 299,
            category = Category.Snacks, stock = 5, displayOrder = 70),

        Product(id = "corny-caramel", slot = "A24", name = "corny big karamella",
            subtitle = "múslístykki, 50g", priceIsk = 299,
            category = Category.Snacks, stock = 4, displayOrder = 80),

        Product(id = "oat-king-chocolate", slot = "A31", name = "oat king chocolate",
            subtitle = "próteinstykki, 95g", priceIsk = 499,
            category = Category.Healthy, stock = 0, displayOrder = 90),

        Product(id = "oat-king-nut", slot = "A32", name = "oat king nut",
            subtitle = "próteinstykki, 95g", priceIsk = 499,
            category = Category.Healthy, stock = 6, displayOrder = 100),

        Product(id = "powerade-blue", slot = "A41", name = "powerade blár",
            subtitle = "íþróttadrykkur, 500ml", priceIsk = 499,
            category = Category.Drinks, stock = 9, displayOrder = 110),

        Product(id = "powerade-yellow", slot = "A42", name = "powerade gulur",
            subtitle = "íþróttadrykkur, 500ml", priceIsk = 499,
            category = Category.Drinks, stock = 8, displayOrder = 120),

        Product(id = "pagen-gifflar", slot = "A43", name = "pagen gifflar",
            subtitle = "kanil, 225g", priceIsk = 639,
            category = Category.Snacks, stock = 3, displayOrder = 130),

        Product(id = "fylkis-brusi", slot = "A44", name = "fylkis brúsi",
            subtitle = "íþróttadrykkur, 500ml", priceIsk = 381,
            category = Category.Other, stock = 12, displayOrder = 140, featured = true),

        Product(id = "golfkulur", slot = "A51", name = "3× golfkúlur",
            subtitle = "premium", priceIsk = 849,
            category = Category.Other, stock = 4, displayOrder = 150),

        Product(id = "kaffi-latte", slot = "A52", name = "kaffidrykkur",
            subtitle = "latte, ískalt", priceIsk = 525,
            category = Category.Coffee, stock = 6, displayOrder = 160),
    )
}
